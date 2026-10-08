package config

import "os"

type Environment string
type Stage string

const (
	EnvironmentLocal      Environment = "local"
	EnvironmentSingleNode Environment = "single-node"

	StageDev  Stage = "dev"
	StageTest Stage = "test"
	StageProd Stage = "prod"
)

type ServiceConfig struct {
	ServiceName string
	Environment Environment
	Stage       Stage
	HTTPAddress string
}

func Load(serviceName string, defaultAddress string) ServiceConfig {
	env := os.Getenv("RUCORD_ENV")
	if env == "" {
		env = string(EnvironmentLocal)
	}

	stage := os.Getenv("RUCORD_STAGE")
	if stage == "" {
		stage = string(StageDev)
	}

	address := os.Getenv("RUCORD_HTTP_ADDRESS")
	if address == "" {
		address = defaultAddress
	}

	return ServiceConfig{
		ServiceName: serviceName,
		Environment: Environment(env),
		Stage:       Stage(stage),
		HTTPAddress: address,
	}
}
