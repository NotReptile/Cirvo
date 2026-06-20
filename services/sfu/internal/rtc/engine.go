package rtc

import (
	"log/slog"
	"net"

	"github.com/pion/webrtc/v4"
)

// EngineConfig — сетевые настройки медиа-плоскости.
type EngineConfig struct {
	// Один UDP-порт для всего RTP/RTCP-трафика (ICE UDPMux). Упрощает
	// docker port-mapping и firewall до одной строки.
	UDPPort int
	// Публичные IP сервера — анонсируются как host-кандидаты (NAT 1:1).
	// Пусто = только локальные интерфейсы (ок для dev / hairpin-LAN).
	PublicIPs []string
}

// Engine владеет общим webrtc.API (один UDP-сокет на все PeerConnection'ы).
type Engine struct {
	api    *webrtc.API
	udpLis *net.UDPConn
}

func NewEngine(logger *slog.Logger, cfg EngineConfig) (*Engine, error) {
	udpLis, err := net.ListenUDP("udp", &net.UDPAddr{Port: cfg.UDPPort})
	if err != nil {
		return nil, err
	}

	settings := webrtc.SettingEngine{}
	settings.SetICEUDPMux(webrtc.NewICEUDPMux(nil, udpLis))
	if len(cfg.PublicIPs) > 0 {
		settings.SetNAT1To1IPs(cfg.PublicIPs, webrtc.ICECandidateTypeHost)
	}

	media := &webrtc.MediaEngine{}
	if err := media.RegisterDefaultCodecs(); err != nil {
		_ = udpLis.Close()
		return nil, err
	}

	logger.Info("sfu engine ready", "udpPort", cfg.UDPPort, "publicIPs", cfg.PublicIPs)
	return &Engine{
		api: webrtc.NewAPI(
			webrtc.WithSettingEngine(settings),
			webrtc.WithMediaEngine(media),
		),
		udpLis: udpLis,
	}, nil
}

// NewPeerConnection — серверная PC. ICE-серверы не нужны: SFU доступен
// напрямую (host-кандидаты + публичный IP), TURN — забота клиента.
func (e *Engine) NewPeerConnection() (*webrtc.PeerConnection, error) {
	return e.api.NewPeerConnection(webrtc.Configuration{})
}

func (e *Engine) Close() error {
	return e.udpLis.Close()
}
