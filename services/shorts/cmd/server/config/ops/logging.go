package ops

// LoggingConfig specification for logging config
type LoggingConfig struct {
	Level string `json:"level" yaml:"level" mapstructure:"level" validate:"oneof=panic fatal error warning info debug trace"`
}
