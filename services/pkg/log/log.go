package log

import (
	"strings"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"google.golang.org/grpc/codes"
)

var atomicLevel zap.AtomicLevel

type Logger struct {
	*zap.SugaredLogger
}

var stringToLevel = map[string]zapcore.Level{
	"debug": zap.DebugLevel,
	"info":  zap.InfoLevel,
	"warn":  zap.WarnLevel,
	"error": zap.ErrorLevel,
	"fatal": zap.FatalLevel,
}

func NewLogger() *Logger {
	cfg := zap.NewDevelopmentConfig()
	atomicLevel = zap.NewAtomicLevelAt(zap.DebugLevel)
	cfg.Level = atomicLevel
	logger, err := cfg.Build()
	if err != nil {
		panic(err)
	}
	zap.ReplaceGlobals(logger)
	return &Logger{logger.Sugar()}
}

func (*Logger) SetLevel(level string) {
	atomicLevel.SetLevel(stringToLevel[strings.ToLower(level)])
}

func LevelFunc(code codes.Code) zapcore.Level {
	if code == codes.OK || code == codes.NotFound {
		return zapcore.InfoLevel
	}
	return zapcore.ErrorLevel
}

func Infof(template string, args ...interface{}) {
	zap.S().Infof(template, args...)
}

// Fatalf uses fmt.Sprintf to construct and log a message at fatal level.
func Fatalf(template string, args ...interface{}) {
	zap.S().Fatalf(template, args...)
}

func Errorf(template string, args ...interface{}) {
	zap.S().Errorf(template, args...)
}

func Debugf(template string, args ...interface{}) {
	zap.S().Errorf(template, args...)
}

func Fatal(msg interface{}) {
	zap.S().Fatal(msg)
}
