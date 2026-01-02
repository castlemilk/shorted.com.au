package shorts

type StorageBackend string

const (
	FireStore     StorageBackend = "firestore"
	MemoryStorage StorageBackend = "inmemory"
	DynamoDB      StorageBackend = "dynamodb"
	PostgresStore StorageBackend = "postgres"
)

type Config struct {
	StorageBackend   StorageBackend `json:"backend" yaml:"backend" mapstructure:"backend"`
	DynamoDBRegion   string         `json:"dynamodb_region"  yaml:"dynamodb_region" mapstructure:"dynamodb_region"`
	DynamoDBTable    string         `json:"dynamodb_table"   yaml:"dynamodb_table"  mapstructure:"dynamodb_table"`
	DynamoDBEndpoint string         `json:"dynamodb_endpoint" yaml:"dynamodb_endpoint" mapstructure:"dynamodb_endpoint"`
	PostgresAddress  string         `json:"postgres_address"    yaml:"postgres_address"    mapstructure:"postgres_address"`
	PostgresUsername string         `json:"postgres_username"    yaml:"postgres_username"    mapstructure:"postgres_username"`
	PostgresPassword string         `json:"postgres_password" yaml:"postgres_password" mapstructure:"postgres_password"`
	PostgresDatabase string         `json:"postgres_database" yaml:"postgres_database" mapstructure:"postgres_database"`
}

const (
	defaultDynamoDBRegion   = "ap-southeast-1"
	defaultDynamoDBTable    = "Users"
	defaultPostgresAddress  = "localhost:5438"
	defaultPostgresUsername = "admin"
	defaultPostgresDatabase = "shorts"
	defaultPostgresPassword = "password"
)

func DefaultPostgresConfig() Config {
	return Config{
		StorageBackend:   PostgresStore,
		PostgresAddress:  defaultPostgresAddress,
		PostgresUsername: defaultPostgresUsername,
		PostgresDatabase: defaultPostgresDatabase,
		PostgresPassword: defaultPostgresPassword,
	}
}
