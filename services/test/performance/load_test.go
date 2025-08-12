package performance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/tsenart/vegeta/v12/lib"
)

const (
	defaultBaseURL = "http://localhost:9091"
	contentType    = "application/json"
)

// TestConfig holds configuration for performance tests
type TestConfig struct {
	BaseURL   string
	Rate      uint64        // requests per second
	Duration  time.Duration // test duration
	UserCount int           // concurrent users for user simulation tests
}

// PerformanceMetrics holds results from performance tests
type PerformanceMetrics struct {
	TestName        string        `json:"test_name"`
	Rate           uint64        `json:"requests_per_second"`
	Duration       time.Duration `json:"duration"`
	TotalRequests  uint64        `json:"total_requests"`
	Success        float64       `json:"success_rate"`
	ErrorRate      float64       `json:"error_rate"`
	MeanLatency    time.Duration `json:"mean_latency"`
	P50Latency     time.Duration `json:"p50_latency"`
	P95Latency     time.Duration `json:"p95_latency"`
	P99Latency     time.Duration `json:"p99_latency"`
	MaxLatency     time.Duration `json:"max_latency"`
	ThroughputMBps float64       `json:"throughput_mbps"`
	Timestamp      time.Time     `json:"timestamp"`
}

// EndpointTest represents a single endpoint test configuration
type EndpointTest struct {
	Name     string
	Method   string
	Path     string
	Body     []byte
	Headers  map[string]string
}

func getConfig() TestConfig {
	baseURL := os.Getenv("PERF_BASE_URL")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	
	return TestConfig{
		BaseURL: baseURL,
	}
}

// createVegetaTargeter creates a vegeta targeter for the given endpoint test
func createVegetaTargeter(config TestConfig, test EndpointTest) vegeta.Targeter {
	return func(tgt *vegeta.Target) error {
		tgt.Method = test.Method
		tgt.URL = config.BaseURL + test.Path
		tgt.Body = test.Body
		
		// Set default headers
		if tgt.Header == nil {
			tgt.Header = make(http.Header)
		}
		tgt.Header.Set("Content-Type", contentType)
		
		// Add custom headers
		for k, v := range test.Headers {
			tgt.Header.Set(k, v)
		}
		
		return nil
	}
}

// runVegetaAttack runs a vegeta attack and returns performance metrics
func runVegetaAttack(t *testing.T, config TestConfig, test EndpointTest, rate uint64, duration time.Duration) PerformanceMetrics {
	targeter := createVegetaTargeter(config, test)
	attacker := vegeta.NewAttacker()
	
	t.Logf("Starting attack on %s: %d RPS for %v", test.Name, rate, duration)
	
	var metrics vegeta.Metrics
	for res := range attacker.Attack(targeter, vegeta.Rate{Freq: int(rate), Per: time.Second}, duration, test.Name) {
		metrics.Add(res)
	}
	metrics.Close()
	
	// Calculate throughput in MB/s
	totalBytes := float64(metrics.BytesIn.Total + metrics.BytesOut.Total)
	throughputMBps := (totalBytes / (1024 * 1024)) / duration.Seconds()
	
	return PerformanceMetrics{
		TestName:       test.Name,
		Rate:           rate,
		Duration:       duration,
		TotalRequests:  metrics.Requests,
		Success:        metrics.Success * 100,
		ErrorRate:      (1 - metrics.Success) * 100,
		MeanLatency:    metrics.Latencies.Mean,
		P50Latency:     metrics.Latencies.P50,
		P95Latency:     metrics.Latencies.P95,
		P99Latency:     metrics.Latencies.P99,
		MaxLatency:     metrics.Latencies.Max,
		ThroughputMBps: throughputMBps,
		Timestamp:      time.Now(),
	}
}

// TestGetTopShortsLoadTest performs load testing on GetTopShorts endpoint
func TestGetTopShortsLoadTest(t *testing.T) {
	config := getConfig()
	
	payload := map[string]interface{}{
		"period": "1m",
		"limit":  10,
		"offset": 0,
	}
	body, _ := json.Marshal(payload)
	
	test := EndpointTest{
		Name:   "GetTopShorts",
		Method: "POST",
		Path:   "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
		Body:   body,
	}
	
	testScenarios := []struct {
		name     string
		rate     uint64
		duration time.Duration
	}{
		{"Light Load", 10, 30 * time.Second},
		{"Medium Load", 50, 60 * time.Second},
		{"Heavy Load", 100, 60 * time.Second},
		{"Spike Test", 200, 30 * time.Second},
	}
	
	var allMetrics []PerformanceMetrics
	
	for _, scenario := range testScenarios {
		t.Run(scenario.name, func(t *testing.T) {
			metrics := runVegetaAttack(t, config, test, scenario.rate, scenario.duration)
			allMetrics = append(allMetrics, metrics)
			
			// Log and assert performance expectations
			logMetrics(t, metrics)
			assertPerformanceThresholds(t, metrics, scenario.name)
		})
	}
	
	// Save results
	saveResults(t, "GetTopShorts", allMetrics)
}

// TestGetStockLoadTest performs load testing on GetStock endpoint
func TestGetStockLoadTest(t *testing.T) {
	config := getConfig()
	
	// Test with different stock codes
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC", "NAB"}
	
	for _, stockCode := range stockCodes {
		t.Run(fmt.Sprintf("Stock_%s", stockCode), func(t *testing.T) {
			payload := map[string]interface{}{
				"productCode": stockCode,
			}
			body, _ := json.Marshal(payload)
			
			test := EndpointTest{
				Name:   fmt.Sprintf("GetStock_%s", stockCode),
				Method: "POST",
				Path:   "/shorts.v1alpha1.ShortedStocksService/GetStock",
				Body:   body,
			}
			
			metrics := runVegetaAttack(t, config, test, 50, 30*time.Second)
			logMetrics(t, metrics)
			assertPerformanceThresholds(t, metrics, "GetStock")
		})
	}
}

// TestGetStockDataLoadTest performs load testing on GetStockData endpoint
func TestGetStockDataLoadTest(t *testing.T) {
	config := getConfig()
	
	periods := []string{"1w", "1m", "3m", "6m", "1y"}
	
	for _, period := range periods {
		t.Run(fmt.Sprintf("Period_%s", period), func(t *testing.T) {
			payload := map[string]interface{}{
				"productCode": "CBA",
				"period":      period,
			}
			body, _ := json.Marshal(payload)
			
			test := EndpointTest{
				Name:   fmt.Sprintf("GetStockData_%s", period),
				Method: "POST",
				Path:   "/shorts.v1alpha1.ShortedStocksService/GetStockData",
				Body:   body,
			}
			
			metrics := runVegetaAttack(t, config, test, 25, 30*time.Second)
			logMetrics(t, metrics)
			assertPerformanceThresholds(t, metrics, "GetStockData")
		})
	}
}

// TestGetIndustryTreeMapLoadTest performs load testing on GetIndustryTreeMap endpoint
func TestGetIndustryTreeMapLoadTest(t *testing.T) {
	config := getConfig()
	
	payload := map[string]interface{}{
		"period":    "1m",
		"limit":     10,
		"viewMode":  "CURRENT_CHANGE",
	}
	body, _ := json.Marshal(payload)
	
	test := EndpointTest{
		Name:   "GetIndustryTreeMap",
		Method: "POST",
		Path:   "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap",
		Body:   body,
	}
	
	metrics := runVegetaAttack(t, config, test, 20, 45*time.Second)
	logMetrics(t, metrics)
	assertPerformanceThresholds(t, metrics, "GetIndustryTreeMap")
}

// TestConcurrentUsersScenario simulates real user behavior with mixed endpoint calls
func TestConcurrentUsersScenario(t *testing.T) {
	config := getConfig()
	userCounts := []int{10, 50, 100, 200}
	
	for _, userCount := range userCounts {
		t.Run(fmt.Sprintf("%d_Users", userCount), func(t *testing.T) {
			runConcurrentUserScenario(t, config, userCount, 2*time.Minute)
		})
	}
}

// runConcurrentUserScenario simulates realistic user behavior
func runConcurrentUserScenario(t *testing.T, config TestConfig, userCount int, duration time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	
	var wg sync.WaitGroup
	var mu sync.Mutex
	totalRequests := 0
	totalErrors := 0
	var totalLatency time.Duration
	
	t.Logf("Starting %d concurrent users for %v", userCount, duration)
	
	for i := 0; i < userCount; i++ {
		wg.Add(1)
		go func(userID int) {
			defer wg.Done()
			client := &http.Client{Timeout: 30 * time.Second}
			
			for {
				select {
				case <-ctx.Done():
					return
				default:
					// Simulate realistic user behavior
					endpoints := []func() (time.Duration, error){
						func() (time.Duration, error) { return callGetTopShorts(client, config) },
						func() (time.Duration, error) { return callGetStock(client, config, "CBA") },
						func() (time.Duration, error) { return callGetStockData(client, config, "BHP", "1m") },
						func() (time.Duration, error) { return callGetIndustryTreeMap(client, config) },
					}
					
					// Random endpoint selection with weighted probability
					endpointIdx := userID % len(endpoints)
					start := time.Now()
					latency, err := endpoints[endpointIdx]()
					
					mu.Lock()
					totalRequests++
					if err != nil {
						totalErrors++
						t.Logf("User %d error: %v", userID, err)
					}
					totalLatency += latency
					mu.Unlock()
					
					// Think time between requests (1-3 seconds)
					time.Sleep(time.Duration(1000+userID%2000) * time.Millisecond)
				}
			}
		}(i)
	}
	
	wg.Wait()
	
	// Calculate and log results
	avgLatency := totalLatency / time.Duration(totalRequests)
	errorRate := float64(totalErrors) / float64(totalRequests) * 100
	rps := float64(totalRequests) / duration.Seconds()
	
	t.Logf("Concurrent Users Test Results:")
	t.Logf("  Users: %d", userCount)
	t.Logf("  Total Requests: %d", totalRequests)
	t.Logf("  Error Rate: %.2f%%", errorRate)
	t.Logf("  Average Latency: %v", avgLatency)
	t.Logf("  Requests/sec: %.2f", rps)
	
	// Assert performance expectations
	if errorRate > 5.0 {
		t.Errorf("Error rate too high: %.2f%% (expected < 5%%)", errorRate)
	}
	if avgLatency > 2*time.Second {
		t.Errorf("Average latency too high: %v (expected < 2s)", avgLatency)
	}
}

// Helper functions for API calls
func callGetTopShorts(client *http.Client, config TestConfig) (time.Duration, error) {
	payload := map[string]interface{}{"period": "1m", "limit": 10, "offset": 0}
	return makeRequest(client, config.BaseURL+"/shorts.v1alpha1.ShortedStocksService/GetTopShorts", payload)
}

func callGetStock(client *http.Client, config TestConfig, productCode string) (time.Duration, error) {
	payload := map[string]interface{}{"productCode": productCode}
	return makeRequest(client, config.BaseURL+"/shorts.v1alpha1.ShortedStocksService/GetStock", payload)
}

func callGetStockData(client *http.Client, config TestConfig, productCode, period string) (time.Duration, error) {
	payload := map[string]interface{}{"productCode": productCode, "period": period}
	return makeRequest(client, config.BaseURL+"/shorts.v1alpha1.ShortedStocksService/GetStockData", payload)
}

func callGetIndustryTreeMap(client *http.Client, config TestConfig) (time.Duration, error) {
	payload := map[string]interface{}{"period": "1m", "limit": 10, "viewMode": "CURRENT_CHANGE"}
	return makeRequest(client, config.BaseURL+"/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap", payload)
}

func makeRequest(client *http.Client, url string, payload interface{}) (time.Duration, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	
	start := time.Now()
	resp, err := client.Post(url, contentType, bytes.NewBuffer(body))
	latency := time.Since(start)
	
	if err != nil {
		return latency, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode >= 400 {
		return latency, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	
	return latency, nil
}

// logMetrics logs performance metrics
func logMetrics(t *testing.T, metrics PerformanceMetrics) {
	t.Logf("Performance Metrics for %s:", metrics.TestName)
	t.Logf("  Rate: %d RPS", metrics.Rate)
	t.Logf("  Total Requests: %d", metrics.TotalRequests)
	t.Logf("  Success Rate: %.2f%%", metrics.Success)
	t.Logf("  Error Rate: %.2f%%", metrics.ErrorRate)
	t.Logf("  Mean Latency: %v", metrics.MeanLatency)
	t.Logf("  P50 Latency: %v", metrics.P50Latency)
	t.Logf("  P95 Latency: %v", metrics.P95Latency)
	t.Logf("  P99 Latency: %v", metrics.P99Latency)
	t.Logf("  Max Latency: %v", metrics.MaxLatency)
	t.Logf("  Throughput: %.2f MB/s", metrics.ThroughputMBps)
}

// assertPerformanceThresholds asserts performance expectations
func assertPerformanceThresholds(t *testing.T, metrics PerformanceMetrics, testType string) {
	// Define thresholds based on test type
	var maxP95Latency time.Duration
	var minSuccessRate float64
	var maxErrorRate float64
	
	switch testType {
	case "GetTopShorts", "Light Load":
		maxP95Latency = 500 * time.Millisecond
		minSuccessRate = 99.0
		maxErrorRate = 1.0
	case "GetStock":
		maxP95Latency = 300 * time.Millisecond
		minSuccessRate = 99.5
		maxErrorRate = 0.5
	case "GetStockData":
		maxP95Latency = 1 * time.Second
		minSuccessRate = 98.0
		maxErrorRate = 2.0
	case "GetIndustryTreeMap":
		maxP95Latency = 2 * time.Second
		minSuccessRate = 97.0
		maxErrorRate = 3.0
	case "Heavy Load", "Spike Test":
		maxP95Latency = 2 * time.Second
		minSuccessRate = 95.0
		maxErrorRate = 5.0
	default:
		maxP95Latency = 1 * time.Second
		minSuccessRate = 98.0
		maxErrorRate = 2.0
	}
	
	// Assert thresholds
	if metrics.P95Latency > maxP95Latency {
		t.Errorf("P95 latency too high: %v (expected < %v)", metrics.P95Latency, maxP95Latency)
	}
	
	if metrics.Success < minSuccessRate {
		t.Errorf("Success rate too low: %.2f%% (expected >= %.2f%%)", metrics.Success, minSuccessRate)
	}
	
	if metrics.ErrorRate > maxErrorRate {
		t.Errorf("Error rate too high: %.2f%% (expected <= %.2f%%)", metrics.ErrorRate, maxErrorRate)
	}
}

// saveResults saves performance metrics to file
func saveResults(t *testing.T, testName string, metrics []PerformanceMetrics) {
	filename := fmt.Sprintf("performance_results_%s_%s.json", testName, time.Now().Format("2006-01-02_15-04-05"))
	
	data, err := json.MarshalIndent(metrics, "", "  ")
	if err != nil {
		t.Logf("Failed to marshal results: %v", err)
		return
	}
	
	if err := os.WriteFile(filename, data, 0644); err != nil {
		t.Logf("Failed to save results to %s: %v", filename, err)
		return
	}
	
	t.Logf("Performance results saved to %s", filename)
}

// TestDatabaseConnectionPoolUnderLoad tests database connection pool behavior under load
func TestDatabaseConnectionPoolUnderLoad(t *testing.T) {
	config := getConfig()
	
	// Test with high concurrency to stress connection pool
	payload := map[string]interface{}{
		"period": "1m",
		"limit":  10,
		"offset": 0,
	}
	body, _ := json.Marshal(payload)
	
	test := EndpointTest{
		Name:   "GetTopShorts_HighConcurrency",
		Method: "POST",
		Path:   "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
		Body:   body,
	}
	
	// Run with very high concurrency to test connection pool limits
	metrics := runVegetaAttack(t, config, test, 300, 45*time.Second)
	logMetrics(t, metrics)
	
	// Connection pool should handle high load gracefully
	if metrics.ErrorRate > 10.0 {
		t.Errorf("High error rate indicates connection pool issues: %.2f%%", metrics.ErrorRate)
	}
	
	if metrics.P99Latency > 5*time.Second {
		t.Errorf("P99 latency too high, possible connection pool bottleneck: %v", metrics.P99Latency)
	}
}

// TestSustainedLoad runs a sustained load test for 15 minutes
func TestSustainedLoad(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping sustained load test in short mode")
	}
	
	config := getConfig()
	
	payload := map[string]interface{}{
		"period": "1m",
		"limit":  10,
		"offset": 0,
	}
	body, _ := json.Marshal(payload)
	
	test := EndpointTest{
		Name:   "GetTopShorts_Sustained",
		Method: "POST",
		Path:   "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
		Body:   body,
	}
	
	// 15-minute sustained load test
	metrics := runVegetaAttack(t, config, test, 50, 15*time.Minute)
	logMetrics(t, metrics)
	
	// For sustained load, we expect stable performance
	if metrics.ErrorRate > 2.0 {
		t.Errorf("Error rate too high for sustained load: %.2f%%", metrics.ErrorRate)
	}
	
	if metrics.P95Latency > 1*time.Second {
		t.Errorf("P95 latency degraded over sustained load: %v", metrics.P95Latency)
	}
	
	// Save sustained load results separately
	saveResults(t, "SustainedLoad", []PerformanceMetrics{metrics})
}