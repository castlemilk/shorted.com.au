package ops

import (
	"fmt"

	"github.com/spf13/viper"

	flag "github.com/spf13/pflag"
)

type Spec struct {
	Version string        `json:"version" yaml:"version" mapstructure:"version"`
	Commit  string        `json:"commit" yaml:"commit" mapstructure:"commit"`
	Port    int           `json:"port" yaml:"port" mapstructure:"port"`
	Logging LoggingConfig `json:"logging" yaml:"logging" mapstructure:"logging"`
}

const (
	defaultOpsPort      = 8082
	defaultLoggingLevel = "info"
)

var (
	_commit  = "dirty"
	_version = "dev"
)

// Default returns default config for operation related config
func Default() Spec {
	return Spec{
		Version: _version,
		Commit:  _commit,
		Logging: LoggingConfig{
			Level: defaultLoggingLevel,
		},
		Port: defaultOpsPort,
	}
}

// Env binds environment variables to main configuration struct populated by viper
func Env(v *viper.Viper, cfgPrefix, envPrefix string) {
	_ = v.BindEnv(fmt.Sprintf("%s.port", cfgPrefix), fmt.Sprintf("%s_PORT", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.logging.level", cfgPrefix), fmt.Sprintf("%s_LOGGING_LEVEL", envPrefix))
}

// Flags binds flags to main configuration struct populated by viper
func Flags(f *flag.FlagSet, prefix string) {
	f.IntP(fmt.Sprintf("%s.port", prefix), "o", defaultOpsPort, "listening port for operations endpoint")
	f.StringP(fmt.Sprintf("%s.logging.level", prefix), "v", defaultLoggingLevel, "logging level")
}
