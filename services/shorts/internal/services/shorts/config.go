package shorts

import (
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	flag "github.com/spf13/pflag"
	"github.com/spf13/viper"
)

type Config struct {
	Insecure          bool          `json:"insecure"         yaml:"insecure"       mapstructure:"insecure"`
	Port              int           `json:"port"             yaml:"port"           mapstructure:"port" validate:"gte=8000"`
	ShortsStoreConfig shorts.Config `json:"store" yaml:"store" mapstructure:"store"`
}

const (
	defaultInsecure = true
	defaultPort     = 8080
)

func DefaultConfig() Config {
	return Config{
		Insecure:          defaultInsecure,
		Port:              defaultPort,
		ShortsStoreConfig: shorts.DefaultPostgresConfig(),
	}
}

func Env(v *viper.Viper, cfgPrefix, envPrefix string) {
	_ = v.BindEnv(fmt.Sprintf("%s.port", cfgPrefix), fmt.Sprintf("%s_PORT", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.insecure", cfgPrefix), fmt.Sprintf("%s_INSECURE", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.store.backend", cfgPrefix), fmt.Sprintf("%s_STORE_BACKEND", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.store.postgres_address", cfgPrefix), fmt.Sprintf("%s_STORE_POSTGRES_ADDRESS", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.store.postgres_username", cfgPrefix), fmt.Sprintf("%s_STORE_POSTGRES_USERNAME", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.store.postgres_password", cfgPrefix), fmt.Sprintf("%s_STORE_POSTGRES_PASSWORD", envPrefix))
	_ = v.BindEnv(fmt.Sprintf("%s.store.postgres_database", cfgPrefix), fmt.Sprintf("%s_STORE_POSTGRES_DATABASE", envPrefix))
}

func Flags(f *flag.FlagSet, prefix string) {
	f.IntP(fmt.Sprintf("%s.port", prefix), "p", defaultPort, "default port agent will listen on")
	f.StringP(fmt.Sprintf("%s.store.postgres_address", prefix), "e", "", "postgres address")
}
