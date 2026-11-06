package rtc

import (
	"sync"
	"time"
)

// Минимальный интервал между запросами ключевого кадра у издателя.
// Несколько зрителей, потерявших кадр одновременно, не должны слать
// издателю десяток PLI подряд: каждый ключевой кадр при 1440p60 весит
// сотни килобайт и сам по себе вызывает всплеск задержки.
const minKeyframeInterval = 500 * time.Millisecond

// keyframeRequester склеивает запросы ключевого кадра (PLI/FIR зрителей,
// подключение нового зрителя, страховочный таймер) в один PLI издателю.
type keyframeRequester struct {
	mu       sync.Mutex
	last     time.Time
	interval time.Duration
	send     func() error
	now      func() time.Time
}

func newKeyframeRequester(interval time.Duration, send func() error) *keyframeRequester {
	return &keyframeRequester{interval: interval, send: send, now: time.Now}
}

// Request отправляет PLI, если с прошлого прошло не меньше interval.
// Возвращает true, если запрос реально ушёл. nil-получатель (аудио-трек)
// безопасен и ничего не делает.
func (k *keyframeRequester) Request() bool {
	if k == nil {
		return false
	}
	k.mu.Lock()
	t := k.now()
	if !k.last.IsZero() && t.Sub(k.last) < k.interval {
		k.mu.Unlock()
		return false
	}
	k.last = t
	k.mu.Unlock()
	return k.send() == nil
}
