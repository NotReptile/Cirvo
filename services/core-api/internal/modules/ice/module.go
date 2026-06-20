package ice

import (
	"net/http"
	"os"
	"strings"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
	"github.com/NotReptile/RuCord/services/core-api/internal/routing"
)

type Module struct {
	config Config
}

type Config struct {
	STUNURLs       []string
	TURNURL        string
	TURNUsername   string
	TURNCredential string
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
	// SFUURL непустой → клиент использует SFU. omitempty, чтобы для
	// mesh-деплоев старые клиенты не видели поля вообще.
	SFUURL string `json:"sfuUrl,omitempty"`
}

func NewModule() *Module {
	return &Module{config: loadFromEnv()}
}

func (m *Module) RegisterRoutes(router routing.Router) {
	router.Protected("GET /api/v1/ice-servers", m.handle)
}

func (m *Module) handle(w http.ResponseWriter, _ *http.Request) {
	servers := make([]iceServer, 0, 2)
	if len(m.config.STUNURLs) > 0 {
		servers = append(servers, iceServer{URLs: m.config.STUNURLs})
	}
	if m.config.TURNURL != "" {
		servers = append(servers, iceServer{
			URLs:       []string{m.config.TURNURL},
			Username:   m.config.TURNUsername,
			Credential: m.config.TURNCredential,
		})
	}
	sharedhttp.WriteJSON(w, http.StatusOK, response{IceServers: servers, SFUURL: m.config.SFUURL})
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
	return Config{
		STUNURLs:       stuns,
		TURNURL:        strings.TrimSpace(os.Getenv("ICE_TURN_URL")),
		TURNUsername:   strings.TrimSpace(os.Getenv("ICE_TURN_USERNAME")),
		TURNCredential: strings.TrimSpace(os.Getenv("ICE_TURN_CREDENTIAL")),
		SFUURL:         strings.TrimSpace(os.Getenv("RUCORD_SFU_URL")),
	}
}

// SFUEnabled сообщает, развёрнут ли SFU (для voice-лимита в app.go).
func SFUEnabled() bool {
	return strings.TrimSpace(os.Getenv("RUCORD_SFU_URL")) != ""
}
