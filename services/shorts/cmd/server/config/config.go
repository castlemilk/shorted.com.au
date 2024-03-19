package config

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts"

	"github.com/castlemilk/shorted.com.au/services/shorts/cmd/server/config/ops"
	"github.com/go-playground/validator/v10"
	"github.com/mitchellh/mapstructure"
	flag "github.com/spf13/pflag"
	"github.com/spf13/viper"
	"gopkg.in/yaml.v2"
)

type Config struct {
	AppSpec shorts.Config `json:"app"   yaml:"app"    mapstructure:"app" validate:"required"`
	OpsSpec ops.Spec      `json:"ops" yaml:"ops" mapstructure:"ops" validate:"required"`
}

const (
	appSpec = "app"
	opsSpec = "ops"
)

// Load configuration during application startup. Will handle loading with precedence of flag > config file > environment variable
func Load() (*Config, error) {
	v := viper.New()
	f := flag.CommandLine

	registerEnv(v)
	registerFlags(f)

	config, err := load(v, f)

	if err != nil {
		return nil, err
	}
	return config, nil
}

func load(v *viper.Viper, f *flag.FlagSet) (*Config, error) {
	var config Config

	v.SetDefault(appSpec, getMap(shorts.DefaultConfig()))
	v.SetDefault(opsSpec, getMap(ops.Default()))

	configFile, _ := f.GetString("config")

	if configFile != "" {
		// use explicit config path defined
		v.SetConfigFile(configFile)
	} else {
		// auto discover config file
		v.SetConfigType("yaml")
		v.SetConfigName("config")
		v.AddConfigPath("/config")
		v.AddConfigPath("/app/config")
	}

	_ = v.BindPFlags(f)
	_ = v.ReadInConfig()

	if err := v.Unmarshal(&config); err != nil {
		return nil, err
	}
	validate := validator.New()
	fmt.Printf("config: %+v", config)
	err := validate.Struct(config)

	if err != nil {
		return nil, err
	}

	return &config, nil

}

func registerEnv(v *viper.Viper) {
	_ = v.BindEnv("config", "CONFIG_PATH")

	ops.Env(v, opsSpec, strings.ToUpper(opsSpec))
	shorts.Env(v, appSpec, strings.ToUpper((appSpec)))

}

func registerFlags(f *flag.FlagSet) {
	f.StringP("config", "c", "", "configuration path to use for server")
	ops.Flags(f, opsSpec)
	shorts.Flags(f, appSpec)
}

// getMap - converts struct into map, required for viper to correctly load
func getMap(config interface{}) map[string]interface{} {
	var inInterface map[string]interface{}
	_ = mapstructure.Decode(config, &inInterface)
	return inInterface
}

// ServeAsJSON runtime configuration as JSON
func (c *Config) ServeAsJSON(w http.ResponseWriter, r *http.Request) {
	payload, err := json.Marshal(c)
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)

		_, _ = w.Write(([]byte(`{"Error": "Failed to return config as json"}`)))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(payload)
	if err != nil {
		_, _ = w.Write([]byte(`{"Error": "Failed to write json"}`))
	}
}

// ServeAsYAML runetime configuration as YAML
func (c *Config) ServeAsYAML(w http.ResponseWriter, r *http.Request) {
	payload, err := yaml.Marshal(c)
	w.Header().Set("Content-Type", "application/yaml")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)

		_, _ = w.Write(([]byte(`{"Error": "Failed to return config as yaml"}`)))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, err = w.Write(payload)
	if err != nil {
		_, _ = w.Write([]byte(`{"Error": "Failed to write yaml"}`))
	}
}
