package rtc

import (
	"log/slog"
	"sync"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"
)

// Signaler — абстракция WS-соединения клиента (реализация в transport).
// Send не должен блокировать надолго (write deadline на стороне transport).
type Signaler interface {
	Send(event string, payload any) error
	// Close рвёт WS; read-loop transport'а после этого вызовет Peer.Close().
	Close(reason string)
}

// Manager — реестр комнат. Комната = voice-канал.
type Manager struct {
	logger *slog.Logger
	engine *Engine

	mu    sync.Mutex
	rooms map[uuid.UUID]*Room
}

func NewManager(logger *slog.Logger, engine *Engine) *Manager {
	return &Manager{logger: logger, engine: engine, rooms: make(map[uuid.UUID]*Room)}
}

// Join создаёт peer'а в комнате канала. Повторный join той же сессии
// (reconnect после обрыва WS) выталкивает старого peer'а.
func (m *Manager) Join(channelID, userID, sessionID uuid.UUID, signal Signaler) (*Peer, error) {
	m.mu.Lock()
	room, ok := m.rooms[channelID]
	if !ok {
		room = &Room{
			id:      channelID,
			manager: m,
			logger:  m.logger.With("channel", channelID.String()),
			peers:   make(map[uuid.UUID]*Peer),
			tracks:  make(map[string]*publishedTrack),
		}
		m.rooms[channelID] = room
	}
	m.mu.Unlock()

	if prev := room.findPeer(sessionID); prev != nil {
		prev.Close("replaced by reconnect")
	}

	peer, err := newPeer(room, userID, sessionID, signal)
	if err != nil {
		return nil, err
	}
	room.addPeer(peer)
	return peer, nil
}

func (m *Manager) dropRoomIfEmpty(room *Room) {
	m.mu.Lock()
	defer m.mu.Unlock()
	room.mu.Lock()
	empty := len(room.peers) == 0
	room.mu.Unlock()
	if empty {
		delete(m.rooms, room.id)
	}
}

// publishedTrack — опубликованный кем-то трек, который форвардится
// остальным. Ключ в Room.tracks — session/trackID (трек-id уникален
// в рамках паблишера, но не глобально).
type publishedTrack struct {
	owner    uuid.UUID // sessionID паблишера
	local    *webrtc.TrackLocalStaticRTP
	keyframe *keyframeRequester // nil для аудио
}

type Room struct {
	id      uuid.UUID
	manager *Manager
	logger  *slog.Logger

	mu     sync.Mutex
	peers  map[uuid.UUID]*Peer
	tracks map[string]*publishedTrack
}

func trackKey(owner uuid.UUID, trackID string) string {
	return owner.String() + "/" + trackID
}

func (r *Room) findPeer(sessionID uuid.UUID) *Peer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.peers[sessionID]
}

// addPeer регистрирует peer'а и подписывает его на все уже
// опубликованные треки комнаты (один renegotiate в конце).
func (r *Room) addPeer(p *Peer) {
	r.mu.Lock()
	r.peers[p.sessionID] = p
	existing := make([]*publishedTrack, 0, len(r.tracks))
	for _, t := range r.tracks {
		existing = append(existing, t)
	}
	r.mu.Unlock()

	for _, t := range existing {
		p.addForward(t.local, t.keyframe)
	}
	// Initial sub.offer шлём всегда — даже без треков (datachannel в sub-PC
	// даёт валидный SDP и устанавливает ICE заранее, чтобы первый трек
	// не ждал handshake).
	p.negotiateSub()
}

// publish раздаёт новый трек всем остальным peer'ам комнаты.
func (r *Room) publish(owner *Peer, local *webrtc.TrackLocalStaticRTP, keyframe *keyframeRequester) {
	r.mu.Lock()
	r.tracks[trackKey(owner.sessionID, local.ID())] = &publishedTrack{owner: owner.sessionID, local: local, keyframe: keyframe}
	subscribers := r.othersLocked(owner.sessionID)
	r.mu.Unlock()

	for _, p := range subscribers {
		p.addForward(local, keyframe)
		p.negotiateSub()
	}
}

// unpublish убирает трек у подписчиков (паблишер выключил камеру/экран
// или ушёл).
func (r *Room) unpublish(owner *Peer, local *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	delete(r.tracks, trackKey(owner.sessionID, local.ID()))
	subscribers := r.othersLocked(owner.sessionID)
	r.mu.Unlock()

	for _, p := range subscribers {
		p.removeForward(local)
		p.negotiateSub()
	}
}

func (r *Room) removePeer(p *Peer) {
	r.mu.Lock()
	if r.peers[p.sessionID] != p {
		// Peer уже заменён reconnect'ом — не трогаем нового.
		r.mu.Unlock()
		return
	}
	delete(r.peers, p.sessionID)
	r.mu.Unlock()
	r.manager.dropRoomIfEmpty(r)
}

func (r *Room) othersLocked(except uuid.UUID) []*Peer {
	out := make([]*Peer, 0, len(r.peers))
	for sid, p := range r.peers {
		if sid != except {
			out = append(out, p)
		}
	}
	return out
}
