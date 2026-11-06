package rtc

import (
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Страховочный PLI: основной путь — по запросу (PLI/FIR зрителя, новый
// подписчик, см. keyframe.go). Периодический ключевой кадр при 1440p60 —
// это всплеск в сотни КБ каждые N секунд, заметный как «дёргание», поэтому
// интервал большой: он нужен лишь на случай потерянного запроса.
const pliInterval = 5 * time.Second
const negotiationTimeout = 10 * time.Second

// SDPPayload / ICEPayload — JSON-формы сигналинга (зеркало клиента).
type SDPPayload struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type ICEPayload struct {
	Candidate *webrtc.ICECandidateInit `json:"candidate"`
}

// Peer — один участник: publisher-PC (клиент шлёт медиа, клиент же
// offerer) + subscriber-PC (сервер шлёт форвард-треки, сервер offerer).
// Разделение на два PC исключает glare: на каждом PC offer'ы ходят
// только в одну сторону, perfect-negotiation не нужен.
type Peer struct {
	userID    uuid.UUID
	sessionID uuid.UUID
	room      *Room
	logger    *slog.Logger
	signal    Signaler

	pub *webrtc.PeerConnection
	sub *webrtc.PeerConnection

	mu          sync.Mutex
	negotiating bool // sub.offer отправлен, ждём sub.answer
	negPending  bool // за время переговоров трек-сет изменился ещё раз
	negTimer    *time.Timer
	closed      bool
	published   []*webrtc.TrackLocalStaticRTP
}

func newPeer(room *Room, userID, sessionID uuid.UUID, signal Signaler) (*Peer, error) {
	pub, err := room.manager.engine.NewPeerConnection()
	if err != nil {
		return nil, err
	}
	sub, err := room.manager.engine.NewPeerConnection()
	if err != nil {
		_ = pub.Close()
		return nil, err
	}

	p := &Peer{
		userID:    userID,
		sessionID: sessionID,
		room:      room,
		logger:    room.logger.With("session", sessionID.String()),
		signal:    signal,
		pub:       pub,
		sub:       sub,
	}

	// Datachannel на sub-PC: даёт m-line в initial offer (SDP без
	// единой секции невалиден) и устанавливает ICE/DTLS до появления
	// первого трека.
	if _, err := sub.CreateDataChannel("sfu", nil); err != nil {
		_ = pub.Close()
		_ = sub.Close()
		return nil, err
	}

	pub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		_ = p.signal.Send("pub.ice", ICEPayload{Candidate: &init})
	})
	sub.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		_ = p.signal.Send("sub.ice", ICEPayload{Candidate: &init})
	})

	pub.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		p.forwardTrack(remote)
	})

	// Обрыв медиа-транспорта без закрытия WS (краш клиента, смена сети) —
	// рвём сигналинг, transport закроет peer'а целиком.
	onDead := func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			p.signal.Close("media transport lost")
		}
	}
	pub.OnConnectionStateChange(onDead)
	sub.OnConnectionStateChange(onDead)

	return p, nil
}

func (p *Peer) SessionID() uuid.UUID { return p.sessionID }

// ---- входящий сигналинг (вызывается из WS read-loop, последовательно) ----

func (p *Peer) HandlePubOffer(desc SDPPayload) {
	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: desc.SDP}
	if err := p.pub.SetRemoteDescription(offer); err != nil {
		p.logger.Warn("pub offer rejected", "error", err)
		return
	}
	answer, err := p.pub.CreateAnswer(nil)
	if err != nil {
		p.logger.Warn("pub answer create failed", "error", err)
		return
	}
	if err := p.pub.SetLocalDescription(answer); err != nil {
		p.logger.Warn("pub answer apply failed", "error", err)
		return
	}
	_ = p.signal.Send("pub.answer", SDPPayload{Type: "answer", SDP: answer.SDP})
}

func (p *Peer) HandleSubAnswer(desc SDPPayload) {
	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: desc.SDP}
	if err := p.sub.SetRemoteDescription(answer); err != nil {
		p.logger.Warn("sub answer rejected", "error", err)
		p.failNegotiation("sub answer rejected")
		return
	}
	p.mu.Lock()
	if p.negTimer != nil {
		p.negTimer.Stop()
		p.negTimer = nil
	}
	p.negotiating = false
	pending := p.negPending
	p.negPending = false
	p.mu.Unlock()
	if pending {
		p.negotiateSub()
	}
}

func (p *Peer) HandlePubICE(payload ICEPayload) {
	if payload.Candidate == nil {
		return
	}
	if err := p.pub.AddICECandidate(*payload.Candidate); err != nil {
		p.logger.Debug("pub ice rejected", "error", err)
	}
}

func (p *Peer) HandleSubICE(payload ICEPayload) {
	if payload.Candidate == nil {
		return
	}
	if err := p.sub.AddICECandidate(*payload.Candidate); err != nil {
		p.logger.Debug("sub ice rejected", "error", err)
	}
}

// ---- форвардинг ------------------------------------------------------------

// forwardTrack читает RTP опубликованного трека и пишет в локальный
// TrackLocalStaticRTP, разданный подписчикам. streamID = sessionID
// паблишера — клиент группирует приходящие треки по stream.id и так
// сопоставляет их участникам (msid доезжает в SDP).
func (p *Peer) forwardTrack(remote *webrtc.TrackRemote) {
	local, err := webrtc.NewTrackLocalStaticRTP(remote.Codec().RTPCodecCapability, remote.ID(), p.sessionID.String())
	if err != nil {
		p.logger.Warn("local track create failed", "error", err)
		return
	}

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.published = append(p.published, local)
	p.mu.Unlock()

	// Для видео — общий throttled-запрос ключевого кадра у издателя; им
	// пользуются и зрители (PLI/FIR), и страховочный таймер.
	var keyframe *keyframeRequester
	stopPLI := make(chan struct{})
	if remote.Kind() == webrtc.RTPCodecTypeVideo {
		ssrc := uint32(remote.SSRC())
		keyframe = newKeyframeRequester(minKeyframeInterval, func() error {
			return p.pub.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
		})
		go p.pliLoop(keyframe, stopPLI)
	}

	p.room.publish(p, local, keyframe)
	p.logger.Info("track published", "kind", remote.Kind().String(), "track", remote.ID())

	buf := make([]byte, 1500)
	for {
		n, _, readErr := remote.Read(buf)
		if readErr != nil {
			break
		}
		if _, writeErr := local.Write(buf[:n]); writeErr != nil && !errors.Is(writeErr, io.ErrClosedPipe) {
			break
		}
	}

	close(stopPLI)
	p.mu.Lock()
	for i, t := range p.published {
		if t == local {
			p.published = append(p.published[:i], p.published[i+1:]...)
			break
		}
	}
	closed := p.closed
	p.mu.Unlock()
	if !closed {
		p.room.unpublish(p, local)
	}
	p.logger.Info("track unpublished", "track", remote.ID())
}

// pliLoop — страховка: редкий периодический keyframe-запрос на случай,
// если PLI зрителя потерялся (VP8/H264 при статичной картинке сами
// ключевые кадры почти не шлют).
func (p *Peer) pliLoop(kf *keyframeRequester, stop <-chan struct{}) {
	ticker := time.NewTicker(pliInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			kf.Request()
		}
	}
}

// addForward подключает чужой опубликованный трек к sub-PC этого peer'а.
// Renegotiation НЕ делает — вызывающий батчит и зовёт negotiateSub().
func (p *Peer) addForward(local *webrtc.TrackLocalStaticRTP, keyframe *keyframeRequester) {
	sender, err := p.sub.AddTrack(local)
	if err != nil {
		p.logger.Warn("forward add failed", "error", err)
		return
	}
	// Читаем входящий RTCP зрителя (иначе внутренние буферы pion копятся).
	// PLI/FIR зрителя пробрасываем издателю: без этого зритель, потерявший
	// опорный кадр, ждал бы страховочного таймера секунды, и картинка
	// «застывала» или сыпалась до следующего ключевого кадра.
	go func() {
		for {
			pkts, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, pkt := range pkts {
				switch pkt.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					keyframe.Request()
				}
			}
		}
	}()
	// Новому зрителю нужен ключевой кадр сразу после подключения.
	keyframe.Request()
}

func (p *Peer) removeForward(local *webrtc.TrackLocalStaticRTP) {
	for _, sender := range p.sub.GetSenders() {
		if sender.Track() == local {
			if err := p.sub.RemoveTrack(sender); err != nil {
				p.logger.Debug("forward remove failed", "error", err)
			}
			return
		}
	}
}

// negotiateSub шлёт свежий offer по sub-PC. Сервер — единственный
// offerer на этом PC, glare невозможен; конкурентные изменения
// трек-сета схлопываются флагом negPending.
func (p *Peer) negotiateSub() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	if p.negotiating {
		p.negPending = true
		p.mu.Unlock()
		return
	}
	p.negotiating = true
	p.mu.Unlock()

	offer, err := p.sub.CreateOffer(nil)
	if err != nil {
		p.logger.Warn("sub offer create failed", "error", err)
		p.failNegotiation("sub offer create failed")
		return
	}
	if err := p.sub.SetLocalDescription(offer); err != nil {
		p.logger.Warn("sub offer apply failed", "error", err)
		p.failNegotiation("sub offer apply failed")
		return
	}
	if err := p.signal.Send("sub.offer", SDPPayload{Type: "offer", SDP: offer.SDP}); err != nil {
		p.logger.Warn("sub offer send failed", "error", err)
		p.failNegotiation("sub offer send failed")
		return
	}
	p.mu.Lock()
	if !p.closed && p.negotiating {
		p.negTimer = time.AfterFunc(negotiationTimeout, func() {
			p.failNegotiation("sub negotiation timeout")
		})
	}
	p.mu.Unlock()
}

func (p *Peer) failNegotiation(reason string) {
	p.mu.Lock()
	if !p.negotiating || p.closed {
		p.mu.Unlock()
		return
	}
	p.negotiating = false
	p.negPending = false
	if p.negTimer != nil {
		p.negTimer.Stop()
		p.negTimer = nil
	}
	p.mu.Unlock()
	p.signal.Close(reason)
}

// Close снимает peer'а с комнаты: его треки убираются у подписчиков,
// оба PC закрываются. Идемпотентен.
func (p *Peer) Close(reason string) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	if p.negTimer != nil {
		p.negTimer.Stop()
		p.negTimer = nil
	}
	published := p.published
	p.published = nil
	p.mu.Unlock()

	for _, local := range published {
		p.room.unpublish(p, local)
	}
	p.room.removePeer(p)
	_ = p.pub.Close()
	_ = p.sub.Close()
	p.logger.Info("peer closed", "reason", reason)
}
