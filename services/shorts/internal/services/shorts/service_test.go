package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"google.golang.org/protobuf/types/known/timestamppb"
)


func TestShortsServer_GetTopShorts(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetTopShortsRequest
		setupMock      func(*mocks.MockShortsStore, *mocks.MockLogger)
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetTopShorts("1M", int32(50), int32(0)).Return([]*stocksv1alpha1.TimeSeriesData{
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetTopShorts("3M", int32(20), int32(10)).Return([]*stocksv1alpha1.TimeSeriesData{
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
				Period: "7Y",
				Limit:  10,
				Offset: 0,
			},
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetTopShorts("1M", int32(10), int32(0)).Return(nil, 0, assert.AnError)
			},
			expectedError: true,
			expectedCode:  connect.CodeInternal,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockLogger := mocks.NewMockLogger(ctrl)
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
		})
	}
}

func TestShortsServer_GetStock(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetStockRequest
		setupMock      func(*mocks.MockShortsStore, *mocks.MockLogger)
		expectedError  bool
		expectedCode   connect.Code
		validateResult func(*testing.T, *stocksv1alpha1.Stock)
	}{
		{
			name: "successful request",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "CBA",
			},
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetStock("CBA").Return(&stocksv1alpha1.Stock{
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetStock("CBA").Return(&stocksv1alpha1.Stock{
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
		{
			name: "invalid product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "INVALID123",
			},
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockLogger := mocks.NewMockLogger(ctrl)
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
		})
	}
}

func TestShortsServer_GetStockData(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	tests := []struct {
		name           string
		request        *shortsv1alpha1.GetStockDataRequest
		setupMock      func(*mocks.MockShortsStore, *mocks.MockLogger)
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				now := time.Now()
				m.EXPECT().GetStockData("CBA", "1M").Return(&stocksv1alpha1.TimeSeriesData{
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()
				m.EXPECT().GetStockData("ZIP", "1M").Return(&stocksv1alpha1.TimeSeriesData{
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
				Period:      "7Y",
			},
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
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
			setupMock: func(m *mocks.MockShortsStore, l *mocks.MockLogger) {
				l.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
			},
			expectedError: true,
			expectedCode:  connect.CodeInvalidArgument,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockLogger := mocks.NewMockLogger(ctrl)
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
		})
	}
}

func TestShortsServer_Caching(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockLogger := mocks.NewMockLogger(ctrl)
	cache := NewMemoryCache(time.Minute)
	server := &ShortsServer{
		store:  mockStore,
		cache:  cache,
		logger: mockLogger,
	}

	mockLogger.EXPECT().Debugf(gomock.Any(), gomock.Any()).AnyTimes()

	// Setup mock to be called only once
	mockStore.EXPECT().GetStock("CBA").Return(&stocksv1alpha1.Stock{
		ProductCode:       "CBA",
		Name:              "Commonwealth Bank",
		PercentageShorted: 2.5,
	}, nil).Times(1)

	// First call should hit the store
	req := &shortsv1alpha1.GetStockRequest{ProductCode: "CBA"}
	resp1, err := server.GetStock(context.Background(), connect.NewRequest(req))
	assert.NoError(t, err)
	assert.Equal(t, "CBA", resp1.Msg.ProductCode)

	// Second call should use cache
	resp2, err := server.GetStock(context.Background(), connect.NewRequest(req))
	assert.NoError(t, err)
	assert.Equal(t, "CBA", resp2.Msg.ProductCode)
}