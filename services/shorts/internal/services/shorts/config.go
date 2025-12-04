package shorts

import (
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	flag "github.com/spf13/pflag"
	"github.com/spf13/viper"
)

type Config struct {
	Insecure          bool          `json:"insecure"         yaml:"insecure"       mapstructure:"insecure"`
	Port              int           `json:"port"             yaml:"port"           mapstructure:"port" validate:"gte=1024"`
	ShortsStoreConfig shorts.Config `json:"store" yaml:"store" mapstructure:"store"`
	// Algolia configuration for search
	AlgoliaAppID     string `json:"algolia_app_id"     yaml:"algolia_app_id"     mapstructure:"algolia_app_id"`
	AlgoliaSearchKey string `json:"algolia_search_key" yaml:"algolia_search_key" mapstructure:"algolia_search_key"`
	AlgoliaAdminKey  string `json:"algolia_admin_key"  yaml:"algolia_admin_key"  mapstructure:"algolia_admin_key"`
	AlgoliaIndex     string `json:"algolia_index"      yaml:"algolia_index"      mapstructure:"algolia_index"`
}

const (
	defaultInsecure = true
	defaultPort     = 9091
)

func DefaultConfig() Config {
	return Config{
		Insecure:          defaultInsecure,
		Port:              defaultPort,
		ShortsStoreConfig: shorts.DefaultPostgresConfig(),
		AlgoliaIndex:      "stocks", // Default index name
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
	// Algolia configuration
	_ = v.BindEnv(fmt.Sprintf("%s.algolia_app_id", cfgPrefix), "ALGOLIA_APP_ID")
	_ = v.BindEnv(fmt.Sprintf("%s.algolia_search_key", cfgPrefix), "ALGOLIA_SEARCH_KEY")
	_ = v.BindEnv(fmt.Sprintf("%s.algolia_admin_key", cfgPrefix), "ALGOLIA_ADMIN_KEY")
	_ = v.BindEnv(fmt.Sprintf("%s.algolia_index", cfgPrefix), "ALGOLIA_INDEX")
}

func Flags(f *flag.FlagSet, prefix string) {
	f.IntP(fmt.Sprintf("%s.port", prefix), "p", defaultPort, "default port service will listen on")
	f.StringP(fmt.Sprintf("%s.store.postgres_address", prefix), "e", "", "postgres address")
}
