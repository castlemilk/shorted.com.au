package shorts

func setupPostgresStore() Store {
	// Assuming you have a function to set env variables for local testing
	return newPostgresStore(DefaultPostgresConfig())
}
