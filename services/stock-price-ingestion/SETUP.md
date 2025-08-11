# Stock Price Ingestion Setup

## Environment Setup

### 1. Create Environment File

Copy the example environment file and add your database credentials:

```bash
cd services
cp .env.example .env
```

Edit `.env` and add your database URL:
```
DATABASE_URL=postgresql://user:password@host:port/database
```

⚠️ **IMPORTANT**: Never commit the `.env` file to git. It's already in `.gitignore`.

### 2. Set Environment Variables

Option A: Export directly (temporary):
```bash
export DATABASE_URL='your-database-url'
```

Option B: Use the setup script:
```bash
./setup-env.sh
```

Option C: Source from .env file:
```bash
export $(cat .env | grep -v '^#' | xargs)
```

## Running Backfill Commands

### Check Current Status
```bash
make history.stock-data.status
```

### Test Backfill (10 stocks)
```bash
DATABASE_URL='your-url' make history.stock-data.backfill-test
```

### Standard Backfill (2 years, all stocks)
```bash
DATABASE_URL='your-url' make history.stock-data.backfill
```

### Custom Backfill
```bash
DATABASE_URL='your-url' make history.stock-data.backfill-custom YEARS=3 LIMIT=100
```

## Database Migrations

### Run migrations
```bash
DATABASE_URL='your-url' make migrate-up-prod
```

### Check migration status
```bash
DATABASE_URL='your-url' make migrate-status-prod
```

## Security Best Practices

1. **Never hardcode credentials** in source files
2. **Use environment variables** for all sensitive data
3. **Keep .env files** out of version control
4. **Use secrets management** in production (GCP Secret Manager)
5. **Rotate credentials** regularly
6. **Use read-only credentials** where possible

## Troubleshooting

### DATABASE_URL not set error
- Make sure you've exported the DATABASE_URL environment variable
- Check that your .env file contains the DATABASE_URL
- Use `echo $DATABASE_URL` to verify it's set (be careful not to log this!)

### Connection failed
- Verify your database URL format: `postgresql://user:password@host:port/database`
- Check network connectivity to the database
- Ensure SSL mode if required: `?sslmode=require`
- Verify database user permissions