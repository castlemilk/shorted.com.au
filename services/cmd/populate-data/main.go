package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/transform"
)

const (
	dataURL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
	baseURL = "https://download.asic.gov.au/short-selling/"
	dataDir = "./data/shorts"
)

var (
	forceDownload = flag.Bool("force-download", false, "Re-download all CSV files even if they exist")
	skipDownload  = flag.Bool("skip-download", false, "Skip downloading, only process existing CSV files")
	limitRecords  = flag.Int("limit", 100, "Number of recent records to process")
)

type ShortSellingRecord struct {
	Date    int    `json:"date"`
	Version string `json:"version"`
}

type CSVRecord struct {
	Date                                                 time.Time
	Product                                              string
	ProductCode                                          string
	ReportedShortPositions                               float64
	TotalProductInIssue                                  float64
	PercentOfTotalProductInIssueReportedAsShortPositions float64
}

func main() {
	flag.Parse()
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	log.Println("🚀 Starting ASIC short selling data population...")

	// Create data directory
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}

	var records []ShortSellingRecord

	if !*skipDownload {
		// Fetch available data records
		log.Println("📥 Fetching available data records...")
		var err error
		records, err = fetchDataRecords()
		if err != nil {
			return fmt.Errorf("failed to fetch data records: %w", err)
		}

		log.Printf("Found %d records available for download", len(records))

		// Download CSV files
		log.Println("⬇️  Downloading CSV files...")
		limit := *limitRecords
		if len(records) < limit {
			limit = len(records)
		}

		// Get the MOST RECENT records (not the oldest)
		recentRecords := records[:limit] // Take from beginning (most recent)
		if err := downloadCSVFiles(recentRecords); err != nil {
			return fmt.Errorf("failed to download CSV files: %w", err)
		}
	} else {
		log.Println("⏭️  Skipping download, using existing CSV files...")
	}

	// Connect to database
	log.Println("🔌 Connecting to database...")
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable is required")
	}

	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer pool.Close()

	// Test connection
	if err := pool.Ping(context.Background()); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	// Process and load data
	log.Println("📊 Processing and loading data into database...")
	if err := processAndLoadData(pool); err != nil {
		return fmt.Errorf("failed to process and load data: %w", err)
	}

	log.Println("✅ Data population completed successfully!")
	return nil
}

func fetchDataRecords() ([]ShortSellingRecord, error) {
	resp, err := http.Get(dataURL)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Error closing response body: %v", err)
		}
	}()

	var records []ShortSellingRecord
	if err := json.NewDecoder(resp.Body).Decode(&records); err != nil {
		return nil, err
	}

	return records, nil
}

func generateDownloadURL(record ShortSellingRecord) string {
	dateStr := fmt.Sprintf("%d", record.Date)
	year, month, day := dateStr[:4], dateStr[4:6], dateStr[6:]
	return fmt.Sprintf("%sRR%s%s%s-%s-SSDailyAggShortPos.csv", baseURL, year, month, day, record.Version)
}

func downloadCSVFiles(records []ShortSellingRecord) error {
	for i, record := range records {
		url := generateDownloadURL(record)
		filename := filepath.Base(url)
		filepath := filepath.Join(dataDir, filename)

		// Skip if file already exists (unless force download is enabled)
		if !*forceDownload {
			if _, err := os.Stat(filepath); err == nil {
				log.Printf("📄 [%d/%d] Skipping %s (already exists)", i+1, len(records), filename)
				continue
			}
		}

		log.Printf("📄 [%d/%d] Downloading %s...", i+1, len(records), filename)
		if err := downloadFile(url, filepath); err != nil {
			log.Printf("⚠️  Failed to download %s: %v", filename, err)
			continue
		}
	}
	return nil
}

func downloadFile(url, filepath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Error closing response body: %v", err)
		}
	}()

	file, err := os.Create(filepath)
	if err != nil {
		return err
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Error closing file: %v", err)
		}
	}()

	_, err = io.Copy(file, resp.Body)
	return err
}

func processAndLoadData(pool *pgxpool.Pool) error {
	// Clear existing data
	_, err := pool.Exec(context.Background(), "TRUNCATE TABLE shorts")
	if err != nil {
		return fmt.Errorf("failed to truncate shorts table: %w", err)
	}

	// Process CSV files
	files, err := filepath.Glob(filepath.Join(dataDir, "*.csv"))
	if err != nil {
		return err
	}

	log.Printf("Processing %d CSV files...", len(files))

	var allRecords []CSVRecord
	for i, file := range files {
		log.Printf("📋 [%d/%d] Processing %s...", i+1, len(files), filepath.Base(file))

		records, err := parseCSVFile(file)
		if err != nil {
			log.Printf("⚠️  Failed to parse %s: %v", filepath.Base(file), err)
			continue
		}

		allRecords = append(allRecords, records...)
	}

	log.Printf("💾 Loading %d records into database...", len(allRecords))

	// Batch insert records
	return batchInsertRecords(pool, allRecords)
}

func parseCSVFile(filename string) ([]CSVRecord, error) {
	// Extract date from filename
	basename := filepath.Base(filename)
	dateStr := strings.TrimPrefix(basename, "RR")
	dateStr = dateStr[:8] // Take first 8 characters (YYYYMMDD)

	date, err := time.Parse("20060102", dateStr)
	if err != nil {
		return nil, fmt.Errorf("failed to parse date from filename: %w", err)
	}

	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Error closing file: %v", err)
		}
	}()

	// Try to detect encoding and convert to UTF-8
	reader := transform.NewReader(file, charmap.Windows1252.NewDecoder())

	csvReader := csv.NewReader(reader)
	csvReader.LazyQuotes = true
	csvReader.TrimLeadingSpace = true

	// Read header
	headers, err := csvReader.Read()
	if err != nil {
		return nil, err
	}

	// Normalize headers
	headerMap := make(map[string]int)
	for i, header := range headers {
		normalized := strings.ToUpper(strings.TrimSpace(strings.ReplaceAll(header, " ", "_")))
		normalized = strings.ReplaceAll(normalized, "%", "PERCENT")
		headerMap[normalized] = i
	}

	var records []CSVRecord
	rowCount := 0
	for {
		row, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("Warning: failed to read CSV row in %s: %v", filepath.Base(filename), err)
			continue
		}

		rowCount++
		record := CSVRecord{Date: date}

		// Parse Product
		if idx, ok := headerMap["PRODUCT"]; ok && idx < len(row) {
			record.Product = strings.TrimSpace(row[idx])
		}

		// Parse Product Code
		if idx, ok := headerMap["PRODUCT_CODE"]; ok && idx < len(row) {
			record.ProductCode = strings.TrimSpace(row[idx])
		}

		// Parse Reported Short Positions
		if idx, ok := headerMap["REPORTED_SHORT_POSITIONS"]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.ReportedShortPositions = val
			}
		}

		// Parse Total Product in Issue
		if idx, ok := headerMap["TOTAL_PRODUCT_IN_ISSUE"]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.TotalProductInIssue = val
			}
		}

		// Parse Percentage
		percentKey := "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		if idx, ok := headerMap[percentKey]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.PercentOfTotalProductInIssueReportedAsShortPositions = val
			}
		}

		// Only add records with valid data
		if record.ProductCode != "" && record.Product != "" {
			records = append(records, record)
		}
	}

	log.Printf("📋 Parsed %d valid records from %s", len(records), filepath.Base(filename))
	return records, nil
}

func batchInsertRecords(pool *pgxpool.Pool, records []CSVRecord) error {
	ctx := context.Background()

	// Process in smaller batches to avoid overwhelming the connection
	batchSize := 1000
	sql := `INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") 
	        VALUES ($1, $2, $3, $4, $5, $6)`

	for i := 0; i < len(records); i += batchSize {
		end := i + batchSize
		if end > len(records) {
			end = len(records)
		}

		batchRecords := records[i:end]
		log.Printf("💾 Inserting batch %d-%d of %d records...", i+1, end, len(records))

		// Begin transaction for this batch
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin transaction: %w", err)
		}

		// Prepare batch insert
		batch := &pgx.Batch{}
		for _, record := range batchRecords {
			batch.Queue(sql,
				record.Date,
				record.Product,
				record.ProductCode,
				record.ReportedShortPositions,
				record.TotalProductInIssue,
				record.PercentOfTotalProductInIssueReportedAsShortPositions,
			)
		}

		// Execute batch
		br := tx.SendBatch(ctx, batch)

		// Process results
		for j := 0; j < len(batchRecords); j++ {
			_, err := br.Exec()
			if err != nil {
				_ = br.Close()
				_ = tx.Rollback(ctx)
				return fmt.Errorf("failed to insert record %d: %w", i+j, err)
			}
		}

		if err := br.Close(); err != nil {
			return fmt.Errorf("failed to close batch: %w", err)
		}

		// Commit transaction
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("failed to commit batch %d: %w", i/batchSize+1, err)
		}
	}

	return nil
}
