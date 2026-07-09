package ice

import (
	"crypto/hmac"
	"crypto/sha1" // coturn REST API specifies HMAC-SHA1.
	"encoding/base64"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/authctx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

type Module struct {
	config Config
}

type Config struct {
	STUNURLs       []string
	TURNURLs       []string
	TURNUsername   string
	TURNCredential string
	TURNSecret     string
	// SFUURL — WebSocket-адрес SFU-сигналинга (F.2), напр.
	// wss://host/sfu/ws. Пусто = SFU не развёрнут, клиент работает в
	// mesh-режиме (до 5 участников). Непусто = клиент гоняет медиа через
	// SFU для всех voice-каналов, mesh-потолок снят (см. voice.meshLimit).
	SFUURL string
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type response struct {
	IceServers []iceServer `json:"iceServers"`
	Mode       string      `json:"mode"`
	// SFUURL непустой → клиент использует SFU. omitempty, чтобы для
	// mesh-деплоев старые клиенты не видели поля вообще.
	SFUURL        string `json:"sfuUrl,omitempty"`
	TURNExpiresAt string `json:"turnExpiresAt,omitempty"`
}

func NewModule() *Module {
	return &Module{config: loadFromEnv()}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/ice-servers", m.handle)
	router.Protected("GET /api/v1/media/config", m.handle)
}

func (m *Module) handle(w http.ResponseWriter, r *http.Request) {
	servers := make([]iceServer, 0, 2)
	turnUsername := m.config.TURNUsername
	turnCredential := m.config.TURNCredential
	turnExpiresAt := ""
	if m.config.TURNSecret != "" && len(m.config.TURNURLs) > 0 {
		expires := time.Now().UTC().Add(time.Hour)
		turnUsername = strconv.FormatInt(expires.Unix(), 10) + ":" + authctx.MustUserID(r.Context()).String()
		mac := hmac.New(sha1.New, []byte(m.config.TURNSecret))
		_, _ = mac.Write([]byte(turnUsername))
		turnCredential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
		turnExpiresAt = expires.Format(time.RFC3339)
	}
	if len(m.config.STUNURLs) > 0 {
		servers = append(servers, iceServer{URLs: m.config.STUNURLs})
	}
	if len(m.config.TURNURLs) > 0 {
		servers = append(servers, iceServer{
			URLs:       m.config.TURNURLs,
			Username:   turnUsername,
			Credential: turnCredential,
		})
	}
	mode := "mesh"
	if m.config.SFUURL != "" {
		mode = "sfu"
	}
	sharedhttp.WriteJSON(w, http.StatusOK, response{
		IceServers: servers, Mode: mode, SFUURL: m.config.SFUURL, TURNExpiresAt: turnExpiresAt,
	})
}

func loadFromEnv() Config {
	stunRaw := strings.TrimSpace(os.Getenv("ICE_STUN_URLS"))
	if stunRaw == "" {
		stunRaw = "stun:stun.l.google.com:19302"
	}
	stuns := make([]string, 0, 2)
	for _, s := range strings.Split(stunRaw, ",") {
		if v := strings.TrimSpace(s); v != "" {
			stuns = append(stuns, v)
		}
	}
	turnRaw := strings.TrimSpace(os.Getenv("ICE_TURN_URLS"))
	if turnRaw == "" {
		turnRaw = strings.TrimSpace(os.Getenv("ICE_TURN_URL"))
	}
	turns := splitList(turnRaw)
	return Config{
		STUNURLs:       stuns,
		TURNURLs:       turns,
		TURNUsername:   strings.TrimSpace(os.Getenv("ICE_TURN_USERNAME")),
		TURNCredential: strings.TrimSpace(os.Getenv("ICE_TURN_CREDENTIAL")),
		TURNSecret:     strings.TrimSpace(os.Getenv("ICE_TURN_SHARED_SECRET")),
		SFUURL:         strings.TrimSpace(os.Getenv("RUCORD_SFU_URL")),
	}
}

func splitList(raw string) []string {
	values := make([]string, 0, 3)
	for _, item := range strings.Split(raw, ",") {
		if value := strings.TrimSpace(item); value != "" {
			values = append(values, value)
		}
	}
	return values
}

// SFUEnabled сообщает, развёрнут ли SFU (для voice-лимита в app.go).
func SFUEnabled() bool {
	return strings.TrimSpace(os.Getenv("RUCORD_SFU_URL")) != ""
}
