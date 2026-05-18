// Package ratelimit реализует rate limiter поверх Redis.
//
// Поддерживает две модели:
//
//   - Allow(...) — token bucket. Для каждого ключа держим в Redis HASH с
//     текущим уровнем токенов и временем последнего обращения. Пополнение
//     вычисляется лениво при следующем вызове. Lua-скрипт делает всё
//     атомарно — никаких race'ов при параллельных запросах от одного IP.
//
//   - Charge(...) — кумулятивный бюджет (например, суммарный размер
//     загрузок за окно). Простой INCRBY с PEXPIRE при первом инкременте.
//
// Ключи в Redis формирует вызывающий — см. Key().
package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Decision — результат проверки. Если Allowed=false, RetryAfter показывает
// сколько ждать до следующей попытки (для Retry-After заголовка).
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
}

// Rule — параметры token bucket'а: Capacity токенов, полностью пополняется
// за Window. Каждый Allow() стоит 1 токен.
type Rule struct {
	Capacity int
	Window   time.Duration
}

// Budget — параметры кумулятивного счётчика. Max единиц на окно Window.
// Cost для каждого вызова задаётся отдельно (например, размер файла).
type Budget struct {
	Max    int64
	Window time.Duration
}

// Limiter — потокобезопасен, можно держать в одном экземпляре на сервис.
type Limiter struct {
	client      *redis.Client
	bucketScript *redis.Script
	chargeScript *redis.Script
}

func New(client *redis.Client) *Limiter {
	return &Limiter{
		client:       client,
		bucketScript: redis.NewScript(tokenBucketLua),
		chargeScript: redis.NewScript(chargeLua),
	}
}

// Allow списывает 1 токен из бакета key. Если токенов нет — Allowed=false и
// RetryAfter ≥ времени, нужного на восстановление одного токена.
func (l *Limiter) Allow(ctx context.Context, key string, rule Rule) (Decision, error) {
	if rule.Capacity <= 0 || rule.Window <= 0 {
		return Decision{}, errors.New("ratelimit: rule must have positive capacity and window")
	}
	nowMs := time.Now().UnixMilli()
	// refill rate в токенах/мс
	refillPerMs := float64(rule.Capacity) / float64(rule.Window.Milliseconds())
	res, err := l.bucketScript.Run(ctx, l.client, []string{key},
		nowMs, rule.Capacity, refillPerMs, 1,
	).Slice()
	if err != nil {
		return Decision{}, fmt.Errorf("ratelimit: bucket script: %w", err)
	}
	allowed, _ := toInt64(res[0])
	retryMs, _ := toInt64(res[1])
	return Decision{
		Allowed:    allowed == 1,
		RetryAfter: time.Duration(retryMs) * time.Millisecond,
	}, nil
}

// Charge увеличивает счётчик key на cost при условии, что новое значение не
// превысит budget.Max. Если превысит — отказ; RetryAfter = TTL ключа.
func (l *Limiter) Charge(ctx context.Context, key string, cost int64, budget Budget) (Decision, error) {
	if budget.Max <= 0 || budget.Window <= 0 {
		return Decision{}, errors.New("ratelimit: budget must have positive max and window")
	}
	if cost <= 0 {
		return Decision{Allowed: true}, nil
	}
	res, err := l.chargeScript.Run(ctx, l.client, []string{key},
		cost, budget.Max, budget.Window.Milliseconds(),
	).Slice()
	if err != nil {
		return Decision{}, fmt.Errorf("ratelimit: charge script: %w", err)
	}
	allowed, _ := toInt64(res[0])
	ttlMs, _ := toInt64(res[1])
	return Decision{
		Allowed:    allowed == 1,
		RetryAfter: time.Duration(ttlMs) * time.Millisecond,
	}, nil
}

// Key строит redis-ключ с общим неймспейсом, чтобы лимиты разных эндпоинтов
// не пересекались случайно.
func Key(scope string, parts ...string) string {
	out := "rl:" + scope
	for _, p := range parts {
		out += ":" + p
	}
	return out
}

func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int:
		return int64(x), true
	case float64:
		return int64(x), true
	}
	return 0, false
}

const tokenBucketLua = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(data[1])
local updated = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  updated = now
end

local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * rate
if tokens > capacity then tokens = capacity end

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate)
end

redis.call('HSET', key, 'tokens', tokens, 'updated_at', now)
-- держим ключ чуть дольше, чем нужно для полного восстановления, чтобы
-- неактивные бакеты не висели в памяти вечно.
local ttl_ms = math.ceil(capacity / rate) + 5000
redis.call('PEXPIRE', key, ttl_ms)

return {allowed, retry_ms}
`

const chargeLua = `
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key) or '0')
if current + cost > max then
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then ttl = window_ms end
  return {0, ttl}
end

local new_val = redis.call('INCRBY', key, cost)
if new_val == cost then
  redis.call('PEXPIRE', key, window_ms)
end
return {1, redis.call('PTTL', key)}
`
