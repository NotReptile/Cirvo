// Package envcompat keeps old deployments working after the RUCORD_* to
// CIRVO_* rename: on import, every RUCORD_* variable that has no CIRVO_*
// counterpart is copied to the new name. Import it for side effects from
// the main package of each service.
package envcompat

import (
	"log"
	"os"
	"strings"
)

const (
	legacyPrefix  = "RUCORD_"
	currentPrefix = "CIRVO_"
)

func init() {
	migrated := 0
	for _, kv := range os.Environ() {
		name, value, ok := strings.Cut(kv, "=")
		if !ok || !strings.HasPrefix(name, legacyPrefix) {
			continue
		}
		current := currentPrefix + strings.TrimPrefix(name, legacyPrefix)
		if _, exists := os.LookupEnv(current); exists {
			continue
		}
		if err := os.Setenv(current, value); err == nil {
			migrated++
		}
	}
	if migrated > 0 {
		log.Printf("envcompat: %d legacy %s* variables mapped to %s*; rename them in your .env", migrated, legacyPrefix, currentPrefix)
	}
}
