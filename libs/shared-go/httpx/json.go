package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const MaxBodyBytes = 1 << 20 // 1 MiB

var ErrMalformedJSON = errors.New("malformed json body")

func ReadJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return ErrMalformedJSON
		}
		return ErrMalformedJSON
	}
	return nil
}
