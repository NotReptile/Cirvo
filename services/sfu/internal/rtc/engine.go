package rtc

import (
	"log/slog"
	"net"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"
)

// Буферы UDP-сокета. Демонстрация экрана 1440p60 даёт 16-20 Мбит/с с
// всплесками на ключевых кадрах; с дефолтными ~200 КБ (Linux) пакеты
// теряются ещё в ядре, до pion. ОС может урезать значение до
// net.core.rmem_max/wmem_max — это только пожелание.
const udpSocketBuffer = 8 << 20

// Размер буфера ретрансмита NACK на исходящий поток (в пакетах, степень
// двойки). Дефолт pion — 1024 пакета, при 20 Мбит/с (~2000 пак/с) это
// меньше 0,5 с истории; 4096 покрывает ~2 с и RTT любой разумной сети.
const nackResponderSize = 4096

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

	if err := udpLis.SetReadBuffer(udpSocketBuffer); err != nil {
		logger.Warn("sfu udp read buffer not applied", "error", err)
	}
	if err := udpLis.SetWriteBuffer(udpSocketBuffer); err != nil {
		logger.Warn("sfu udp write buffer not applied", "error", err)
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

	// Без интерцепторов у NewAPI нет ни NACK (потерянные пакеты не
	// переотправляются), ни TWCC (издатель не получает обратную связь по
	// пропускной способности и держит заниженный битрейт), ни RTCP
	// Sender/Receiver Report. RegisterDefaultInterceptors включает всё это.
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptorsWithOptions(
		media, registry,
		webrtc.WithNackResponderOptions(nack.ResponderSize(nackResponderSize)),
	); err != nil {
		_ = udpLis.Close()
		return nil, err
	}

	logger.Info("sfu engine ready", "udpPort", cfg.UDPPort, "publicIPs", cfg.PublicIPs)
	return &Engine{
		api: webrtc.NewAPI(
			webrtc.WithSettingEngine(settings),
			webrtc.WithMediaEngine(media),
			webrtc.WithInterceptorRegistry(registry),
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
