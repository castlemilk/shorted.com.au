package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// MockStore is a mock implementation of the ShortsStore interface
type MockStore struct {
	mock.Mock
}

func (m *MockStore) GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	args := m.Called(period, limit, offset)
	if args.Get(0) == nil {
		return nil, args.Int(1), args.Error(2)
	}
	return args.Get(0).([]*stocksv1alpha1.TimeSeriesData), args.Int(1), args.Error(2)
}

func (m *MockStore) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	args := m.Called(productCode)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*stocksv1alpha1.Stock), args.Error(1)
}

func (m *MockStore) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
	args := m.Called(productCode, period)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*stocksv1alpha1.TimeSeriesData), args.Error(1)
}

func (m *MockStore) GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error) {
	args := m.Called(productCode)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*stocksv1alpha1.StockDetails), args.Error(1)
}

func (m *MockStore) GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	args := m.Called(limit, period, viewMode)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*stocksv1alpha1.IndustryTreeMap), args.Error(1)
}

// MockLogger is a mock implementation of the Logger interface
type MockLogger struct {
	mock.Mock
}

func (m *MockLogger) Debugf(format string, args ...interface{}) {
	m.Called(format, args)
}

func (m *MockLogger) Infof(format string, args ...interface{}) {
	m.Called(format, args)
}

func (m *MockLogger) Warnf(format string, args ...interface{}) {
	m.Called(format, args)
}

func (m *MockLogger) Errorf(format string, args ...interface{}) {
	m.Called(format, args)
}

func TestShortsServer_GetTopShorts(t *testing.T) {
	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetTopShortsRequest
		setupMock      func(*MockStore, *MockLogger)
		expectedError  bool
		expectedCode   connect.Code
		validateResult func(*testing.T, *shortsv1alpha1.GetTopShortsResponse)
	}{
		{
			name: "successful request with default values",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "",
				Limit:  0,
				Offset: 0,
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				m.On("GetTopShorts", "1M", int32(50), int32(0)).Return([]*stocksv1alpha1.TimeSeriesData{
					{
						ProductCode:         "CBA",
						Name:                "Commonwealth Bank",
						LatestShortPosition: 2.5,
						Points: []*stocksv1alpha1.TimeSeriesPoint{
							{
								Timestamp:     timestamppb.New(time.Now()),
								ShortPosition: 2.5,
							},
						},
					},
				}, 10, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, resp *shortsv1alpha1.GetTopShortsResponse) {
				assert.Len(t, resp.TimeSeries, 1)
				assert.Equal(t, "CBA", resp.TimeSeries[0].ProductCode)
				assert.Equal(t, int32(10), resp.Offset)
			},
		},
		{
			name: "successful request with custom parameters",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "3M",
				Limit:  20,
				Offset: 10,
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				m.On("GetTopShorts", "3M", int32(20), int32(10)).Return([]*stocksv1alpha1.TimeSeriesData{
					{
						ProductCode:         "ZIP",
						Name:                "ZIP Co Limited",
						LatestShortPosition: 12.5,
					},
					{
						ProductCode:         "BHP",
						Name:                "BHP Group",
						LatestShortPosition: 3.2,
					},
				}, 30, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, resp *shortsv1alpha1.GetTopShortsResponse) {
				assert.Len(t, resp.TimeSeries, 2)
				assert.Equal(t, "ZIP", resp.TimeSeries[0].ProductCode)
				assert.Equal(t, "BHP", resp.TimeSeries[1].ProductCode)
				assert.Equal(t, int32(30), resp.Offset)
			},
		},
		{
			name: "invalid period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "2Y",
				Limit:  10,
				Offset: 0,
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
		{
			name: "negative limit",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  -10,
				Offset: 0,
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
		{
			name: "store error",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  10,
				Offset: 0,
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
				m.On("GetTopShorts", "1M", int32(10), int32(0)).Return(nil, 0, assert.AnError)
			},
			expectedError: true,
			expectedCode:  connect.CodeInternal,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := new(MockStore)
			mockLogger := new(MockLogger)
			tt.setupMock(mockStore, mockLogger)

			server := &ShortsServer{
				store:  mockStore,
				cache:  NewMemoryCache(time.Minute),
				logger: mockLogger,
			}

			resp, err := server.GetTopShorts(context.Background(), connect.NewRequest(tt.request))

			if tt.expectedError {
				assert.Error(t, err)
				if tt.expectedCode != 0 {
					assert.Equal(t, tt.expectedCode, connect.CodeOf(err))
				}
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, resp)
				if tt.validateResult != nil {
					tt.validateResult(t, resp.Msg)
				}
			}

			mockStore.AssertExpectations(t)
			mockLogger.AssertExpectations(t)
		})
	}
}

func TestShortsServer_GetStock(t *testing.T) {
	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetStockRequest
		setupMock      func(*MockStore, *MockLogger)
		expectedError  bool
		expectedCode   connect.Code
		validateResult func(*testing.T, *stocksv1alpha1.Stock)
	}{
		{
			name: "successful request",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "CBA",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				m.On("GetStock", "CBA").Return(&stocksv1alpha1.Stock{
					ProductCode:            "CBA",
					Name:                   "Commonwealth Bank",
					PercentageShorted:      2.5,
					TotalProductInIssue:    1000000,
					ReportedShortPositions: 25000,
				}, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, stock *stocksv1alpha1.Stock) {
				assert.NotNil(t, stock)
				assert.Equal(t, "CBA", stock.ProductCode)
				assert.Equal(t, float32(2.5), stock.PercentageShorted)
			},
		},
		{
			name: "normalize stock code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "  cba  ",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				m.On("GetStock", "CBA").Return(&stocksv1alpha1.Stock{
					ProductCode: "CBA",
					Name:        "Commonwealth Bank",
				}, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, stock *stocksv1alpha1.Stock) {
				assert.Equal(t, "CBA", stock.ProductCode)
			},
		},
		{
			name: "empty product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
		{
			name: "invalid product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "INVALID123",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := new(MockStore)
			mockLogger := new(MockLogger)
			tt.setupMock(mockStore, mockLogger)

			server := &ShortsServer{
				store:  mockStore,
				cache:  NewMemoryCache(time.Minute),
				logger: mockLogger,
			}

			resp, err := server.GetStock(context.Background(), connect.NewRequest(tt.request))

			if tt.expectedError {
				assert.Error(t, err)
				if tt.expectedCode != 0 {
					assert.Equal(t, tt.expectedCode, connect.CodeOf(err))
				}
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, resp)
				if tt.validateResult != nil {
					tt.validateResult(t, resp.Msg)
				}
			}

			mockStore.AssertExpectations(t)
			mockLogger.AssertExpectations(t)
		})
	}
}

func TestShortsServer_GetStockData(t *testing.T) {
	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetStockDataRequest
		setupMock      func(*MockStore, *MockLogger)
		expectedError  bool
		expectedCode   connect.Code
		validateResult func(*testing.T, *stocksv1alpha1.TimeSeriesData)
	}{
		{
			name: "successful request with time series data",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "1M",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				now := time.Now()
				m.On("GetStockData", "CBA", "1M").Return(&stocksv1alpha1.TimeSeriesData{
					ProductCode: "CBA",
					Name:        "Commonwealth Bank",
					Points: []*stocksv1alpha1.TimeSeriesPoint{
						{
							Timestamp:     timestamppb.New(now.Add(-24 * time.Hour)),
							ShortPosition: 2.3,
						},
						{
							Timestamp:     timestamppb.New(now),
							ShortPosition: 2.5,
						},
					},
					Max: &stocksv1alpha1.TimeSeriesPoint{
						Timestamp:     timestamppb.New(now),
						ShortPosition: 2.5,
					},
					Min: &stocksv1alpha1.TimeSeriesPoint{
						Timestamp:     timestamppb.New(now.Add(-24 * time.Hour)),
						ShortPosition: 2.3,
					},
				}, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, resp *stocksv1alpha1.TimeSeriesData) {
				assert.NotNil(t, resp)
				assert.Equal(t, "CBA", resp.ProductCode)
				assert.Len(t, resp.Points, 2)
				assert.Equal(t, float64(2.5), resp.Max.ShortPosition)
				assert.Equal(t, float64(2.3), resp.Min.ShortPosition)
			},
		},
		{
			name: "default period when not specified",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "ZIP",
				Period:      "",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Debugf", mock.Anything, mock.Anything).Maybe()
				m.On("GetStockData", "ZIP", "1M").Return(&stocksv1alpha1.TimeSeriesData{
					ProductCode: "ZIP",
					Name:        "ZIP Co Limited",
					Points:      []*stocksv1alpha1.TimeSeriesPoint{},
				}, nil)
			},
			expectedError: false,
			validateResult: func(t *testing.T, resp *stocksv1alpha1.TimeSeriesData) {
				assert.NotNil(t, resp)
				assert.Equal(t, "ZIP", resp.ProductCode)
			},
		},
		{
			name: "invalid period",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "5Y",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
		{
			name: "invalid product code",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "",
				Period:      "1M",
			},
			setupMock: func(m *MockStore, l *MockLogger) {
				l.On("Errorf", mock.Anything, mock.Anything).Maybe()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := new(MockStore)
			mockLogger := new(MockLogger)
			tt.setupMock(mockStore, mockLogger)

			server := &ShortsServer{
				store:  mockStore,
				cache:  NewMemoryCache(time.Minute),
				logger: mockLogger,
			}

			resp, err := server.GetStockData(context.Background(), connect.NewRequest(tt.request))

			if tt.expectedError {
				assert.Error(t, err)
				if tt.expectedCode != 0 {
					assert.Equal(t, tt.expectedCode, connect.CodeOf(err))
				}
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, resp)
				if tt.validateResult != nil {
					tt.validateResult(t, resp.Msg)
				}
			}

			mockStore.AssertExpectations(t)
			mockLogger.AssertExpectations(t)
		})
	}
}

func TestShortsServer_Caching(t *testing.T) {
	mockStore := new(MockStore)
	mockLogger := new(MockLogger)
	cache := NewMemoryCache(time.Minute)
	server := &ShortsServer{
		store:  mockStore,
		cache:  cache,
		logger: mockLogger,
	}

	mockLogger.On("Debugf", mock.Anything, mock.Anything).Maybe()

	// Setup mock to be called only once
	mockStore.On("GetStock", "CBA").Return(&stocksv1alpha1.Stock{
		ProductCode:       "CBA",
		Name:              "Commonwealth Bank",
		PercentageShorted: 2.5,
	}, nil).Once()

	// First call should hit the store
	req := &shortsv1alpha1.GetStockRequest{ProductCode: "CBA"}
	resp1, err := server.GetStock(context.Background(), connect.NewRequest(req))
	assert.NoError(t, err)
	assert.Equal(t, "CBA", resp1.Msg.ProductCode)

	// Second call should use cache
	resp2, err := server.GetStock(context.Background(), connect.NewRequest(req))
	assert.NoError(t, err)
	assert.Equal(t, "CBA", resp2.Msg.ProductCode)

	// Verify the store was only called once
	mockStore.AssertExpectations(t)
}