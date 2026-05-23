// patch.go — мелкие helper'ы для PATCH-семантики, где "поле отсутствует"
// надо отличать от "поле = null". json.RawMessage в map[string] решает.
package role

import (
	"encoding/json"
	"io"
	"net/http"

	sharedhttp "github.com/NotReptile/RuCord/libs/shared-go/httpx"
)

func decodePatchBody(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed body")
		return nil, false
	}
	body := map[string]json.RawMessage{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			sharedhttp.WriteError(w, r, http.StatusBadRequest, sharedhttp.CodeValidationFailed, "malformed json")
			return nil, false
		}
	}
	return body, true
}

func jsonUnmarshal(raw json.RawMessage, dst any) error {
	return json.Unmarshal(raw, dst)
}
