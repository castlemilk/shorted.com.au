// Code generated by protoc-gen-go. DO NOT EDIT.
// versions:
// 	protoc-gen-go v1.33.0
// 	protoc        (unknown)
// source: stocks/v1alpha1/stocks.proto

package stocksv1alpha1

import (
	protoreflect "google.golang.org/protobuf/reflect/protoreflect"
	protoimpl "google.golang.org/protobuf/runtime/protoimpl"
	timestamppb "google.golang.org/protobuf/types/known/timestamppb"
	reflect "reflect"
	sync "sync"
)

const (
	// Verify that this generated code is sufficiently up-to-date.
	_ = protoimpl.EnforceVersion(20 - protoimpl.MinVersion)
	// Verify that runtime/protoimpl is sufficiently up-to-date.
	_ = protoimpl.EnforceVersion(protoimpl.MaxVersion - 20)
)

// A Stock represents a single stock's metadata.
type Stock struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode            string  `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"` // The stock code, e.g., "CBA", "ZIP", "PLS".
	Name                   string  `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`                                  // The full name of the stock.
	TotalProductInIssue    float32 `protobuf:"fixed32,3,opt,name=total_product_in_issue,json=totalProductInIssue,proto3" json:"total_product_in_issue,omitempty"`
	ReportedShortPositions float32 `protobuf:"fixed32,4,opt,name=reported_short_positions,json=reportedShortPositions,proto3" json:"reported_short_positions,omitempty"`
	PercentageShorted      float32 `protobuf:"fixed32,5,opt,name=percentage_shorted,json=percentageShorted,proto3" json:"percentage_shorted,omitempty"` // TODO(castlemilk): add more metadata here as needed
}

func (x *Stock) Reset() {
	*x = Stock{}
	if protoimpl.UnsafeEnabled {
		mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[0]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *Stock) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*Stock) ProtoMessage() {}

func (x *Stock) ProtoReflect() protoreflect.Message {
	mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[0]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use Stock.ProtoReflect.Descriptor instead.
func (*Stock) Descriptor() ([]byte, []int) {
	return file_stocks_v1alpha1_stocks_proto_rawDescGZIP(), []int{0}
}

func (x *Stock) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

func (x *Stock) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *Stock) GetTotalProductInIssue() float32 {
	if x != nil {
		return x.TotalProductInIssue
	}
	return 0
}

func (x *Stock) GetReportedShortPositions() float32 {
	if x != nil {
		return x.ReportedShortPositions
	}
	return 0
}

func (x *Stock) GetPercentageShorted() float32 {
	if x != nil {
		return x.PercentageShorted
	}
	return 0
}

// TimeSeriesData represents time series data for a stock.
type TimeSeriesData struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode string             `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"` // The stock code.
	Name        string             `protobuf:"bytes,3,opt,name=name,proto3" json:"name,omitempty"`
	Points      []*TimeSeriesPoint `protobuf:"bytes,10,rep,name=points,proto3" json:"points,omitempty"` // The time series points.
}

func (x *TimeSeriesData) Reset() {
	*x = TimeSeriesData{}
	if protoimpl.UnsafeEnabled {
		mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[1]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *TimeSeriesData) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*TimeSeriesData) ProtoMessage() {}

func (x *TimeSeriesData) ProtoReflect() protoreflect.Message {
	mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[1]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use TimeSeriesData.ProtoReflect.Descriptor instead.
func (*TimeSeriesData) Descriptor() ([]byte, []int) {
	return file_stocks_v1alpha1_stocks_proto_rawDescGZIP(), []int{1}
}

func (x *TimeSeriesData) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

func (x *TimeSeriesData) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *TimeSeriesData) GetPoints() []*TimeSeriesPoint {
	if x != nil {
		return x.Points
	}
	return nil
}

// TimeSeriesPoint represents a single point in time for the time series data.
type TimeSeriesPoint struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	Timestamp     *timestamppb.Timestamp `protobuf:"bytes,1,opt,name=timestamp,proto3" json:"timestamp,omitempty"`                                // The point in time.
	ShortPosition float64                `protobuf:"fixed64,2,opt,name=short_position,json=shortPosition,proto3" json:"short_position,omitempty"` // The short position at this point in time.
}

func (x *TimeSeriesPoint) Reset() {
	*x = TimeSeriesPoint{}
	if protoimpl.UnsafeEnabled {
		mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[2]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *TimeSeriesPoint) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*TimeSeriesPoint) ProtoMessage() {}

func (x *TimeSeriesPoint) ProtoReflect() protoreflect.Message {
	mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[2]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use TimeSeriesPoint.ProtoReflect.Descriptor instead.
func (*TimeSeriesPoint) Descriptor() ([]byte, []int) {
	return file_stocks_v1alpha1_stocks_proto_rawDescGZIP(), []int{2}
}

func (x *TimeSeriesPoint) GetTimestamp() *timestamppb.Timestamp {
	if x != nil {
		return x.Timestamp
	}
	return nil
}

func (x *TimeSeriesPoint) GetShortPosition() float64 {
	if x != nil {
		return x.ShortPosition
	}
	return 0
}

type StockDetails struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode    string          `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"`
	Name           string          `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`
	Description    string          `protobuf:"bytes,3,opt,name=description,proto3" json:"description,omitempty"`
	Sector         string          `protobuf:"bytes,7,opt,name=sector,proto3" json:"sector,omitempty"`
	TimeSeriesData *TimeSeriesData `protobuf:"bytes,4,opt,name=time_series_data,json=timeSeriesData,proto3" json:"time_series_data,omitempty"`
}

func (x *StockDetails) Reset() {
	*x = StockDetails{}
	if protoimpl.UnsafeEnabled {
		mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[3]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *StockDetails) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*StockDetails) ProtoMessage() {}

func (x *StockDetails) ProtoReflect() protoreflect.Message {
	mi := &file_stocks_v1alpha1_stocks_proto_msgTypes[3]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use StockDetails.ProtoReflect.Descriptor instead.
func (*StockDetails) Descriptor() ([]byte, []int) {
	return file_stocks_v1alpha1_stocks_proto_rawDescGZIP(), []int{3}
}

func (x *StockDetails) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

func (x *StockDetails) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *StockDetails) GetDescription() string {
	if x != nil {
		return x.Description
	}
	return ""
}

func (x *StockDetails) GetSector() string {
	if x != nil {
		return x.Sector
	}
	return ""
}

func (x *StockDetails) GetTimeSeriesData() *TimeSeriesData {
	if x != nil {
		return x.TimeSeriesData
	}
	return nil
}

var File_stocks_v1alpha1_stocks_proto protoreflect.FileDescriptor

var file_stocks_v1alpha1_stocks_proto_rawDesc = []byte{
	0x0a, 0x1c, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2f, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61,
	0x31, 0x2f, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x12, 0x0f,
	0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x1a,
	0x1f, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x2f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x62, 0x75, 0x66,
	0x2f, 0x74, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f,
	0x22, 0xdc, 0x01, 0x0a, 0x05, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x12, 0x21, 0x0a, 0x0c, 0x70, 0x72,
	0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f, 0x63, 0x6f, 0x64, 0x65, 0x18, 0x01, 0x20, 0x01, 0x28, 0x09,
	0x52, 0x0b, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x43, 0x6f, 0x64, 0x65, 0x12, 0x12, 0x0a,
	0x04, 0x6e, 0x61, 0x6d, 0x65, 0x18, 0x02, 0x20, 0x01, 0x28, 0x09, 0x52, 0x04, 0x6e, 0x61, 0x6d,
	0x65, 0x12, 0x33, 0x0a, 0x16, 0x74, 0x6f, 0x74, 0x61, 0x6c, 0x5f, 0x70, 0x72, 0x6f, 0x64, 0x75,
	0x63, 0x74, 0x5f, 0x69, 0x6e, 0x5f, 0x69, 0x73, 0x73, 0x75, 0x65, 0x18, 0x03, 0x20, 0x01, 0x28,
	0x02, 0x52, 0x13, 0x74, 0x6f, 0x74, 0x61, 0x6c, 0x50, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x49,
	0x6e, 0x49, 0x73, 0x73, 0x75, 0x65, 0x12, 0x38, 0x0a, 0x18, 0x72, 0x65, 0x70, 0x6f, 0x72, 0x74,
	0x65, 0x64, 0x5f, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x5f, 0x70, 0x6f, 0x73, 0x69, 0x74, 0x69, 0x6f,
	0x6e, 0x73, 0x18, 0x04, 0x20, 0x01, 0x28, 0x02, 0x52, 0x16, 0x72, 0x65, 0x70, 0x6f, 0x72, 0x74,
	0x65, 0x64, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x50, 0x6f, 0x73, 0x69, 0x74, 0x69, 0x6f, 0x6e, 0x73,
	0x12, 0x2d, 0x0a, 0x12, 0x70, 0x65, 0x72, 0x63, 0x65, 0x6e, 0x74, 0x61, 0x67, 0x65, 0x5f, 0x73,
	0x68, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x18, 0x05, 0x20, 0x01, 0x28, 0x02, 0x52, 0x11, 0x70, 0x65,
	0x72, 0x63, 0x65, 0x6e, 0x74, 0x61, 0x67, 0x65, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x22,
	0x81, 0x01, 0x0a, 0x0e, 0x54, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69, 0x65, 0x73, 0x44, 0x61,
	0x74, 0x61, 0x12, 0x21, 0x0a, 0x0c, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f, 0x63, 0x6f,
	0x64, 0x65, 0x18, 0x01, 0x20, 0x01, 0x28, 0x09, 0x52, 0x0b, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63,
	0x74, 0x43, 0x6f, 0x64, 0x65, 0x12, 0x12, 0x0a, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x18, 0x03, 0x20,
	0x01, 0x28, 0x09, 0x52, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x12, 0x38, 0x0a, 0x06, 0x70, 0x6f, 0x69,
	0x6e, 0x74, 0x73, 0x18, 0x0a, 0x20, 0x03, 0x28, 0x0b, 0x32, 0x20, 0x2e, 0x73, 0x74, 0x6f, 0x63,
	0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x54, 0x69, 0x6d, 0x65,
	0x53, 0x65, 0x72, 0x69, 0x65, 0x73, 0x50, 0x6f, 0x69, 0x6e, 0x74, 0x52, 0x06, 0x70, 0x6f, 0x69,
	0x6e, 0x74, 0x73, 0x22, 0x72, 0x0a, 0x0f, 0x54, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69, 0x65,
	0x73, 0x50, 0x6f, 0x69, 0x6e, 0x74, 0x12, 0x38, 0x0a, 0x09, 0x74, 0x69, 0x6d, 0x65, 0x73, 0x74,
	0x61, 0x6d, 0x70, 0x18, 0x01, 0x20, 0x01, 0x28, 0x0b, 0x32, 0x1a, 0x2e, 0x67, 0x6f, 0x6f, 0x67,
	0x6c, 0x65, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x62, 0x75, 0x66, 0x2e, 0x54, 0x69, 0x6d, 0x65,
	0x73, 0x74, 0x61, 0x6d, 0x70, 0x52, 0x09, 0x74, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70,
	0x12, 0x25, 0x0a, 0x0e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x5f, 0x70, 0x6f, 0x73, 0x69, 0x74, 0x69,
	0x6f, 0x6e, 0x18, 0x02, 0x20, 0x01, 0x28, 0x01, 0x52, 0x0d, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x50,
	0x6f, 0x73, 0x69, 0x74, 0x69, 0x6f, 0x6e, 0x22, 0xca, 0x01, 0x0a, 0x0c, 0x53, 0x74, 0x6f, 0x63,
	0x6b, 0x44, 0x65, 0x74, 0x61, 0x69, 0x6c, 0x73, 0x12, 0x21, 0x0a, 0x0c, 0x70, 0x72, 0x6f, 0x64,
	0x75, 0x63, 0x74, 0x5f, 0x63, 0x6f, 0x64, 0x65, 0x18, 0x01, 0x20, 0x01, 0x28, 0x09, 0x52, 0x0b,
	0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x43, 0x6f, 0x64, 0x65, 0x12, 0x12, 0x0a, 0x04, 0x6e,
	0x61, 0x6d, 0x65, 0x18, 0x02, 0x20, 0x01, 0x28, 0x09, 0x52, 0x04, 0x6e, 0x61, 0x6d, 0x65, 0x12,
	0x20, 0x0a, 0x0b, 0x64, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x69, 0x6f, 0x6e, 0x18, 0x03,
	0x20, 0x01, 0x28, 0x09, 0x52, 0x0b, 0x64, 0x65, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x69, 0x6f,
	0x6e, 0x12, 0x16, 0x0a, 0x06, 0x73, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x18, 0x07, 0x20, 0x01, 0x28,
	0x09, 0x52, 0x06, 0x73, 0x65, 0x63, 0x74, 0x6f, 0x72, 0x12, 0x49, 0x0a, 0x10, 0x74, 0x69, 0x6d,
	0x65, 0x5f, 0x73, 0x65, 0x72, 0x69, 0x65, 0x73, 0x5f, 0x64, 0x61, 0x74, 0x61, 0x18, 0x04, 0x20,
	0x01, 0x28, 0x0b, 0x32, 0x1f, 0x2e, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61,
	0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x54, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69, 0x65, 0x73,
	0x44, 0x61, 0x74, 0x61, 0x52, 0x0e, 0x74, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69, 0x65, 0x73,
	0x44, 0x61, 0x74, 0x61, 0x42, 0xda, 0x01, 0x0a, 0x13, 0x63, 0x6f, 0x6d, 0x2e, 0x73, 0x74, 0x6f,
	0x63, 0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x42, 0x0b, 0x53, 0x74,
	0x6f, 0x63, 0x6b, 0x73, 0x50, 0x72, 0x6f, 0x74, 0x6f, 0x50, 0x01, 0x5a, 0x59, 0x67, 0x69, 0x74,
	0x68, 0x75, 0x62, 0x2e, 0x63, 0x6f, 0x6d, 0x2f, 0x63, 0x61, 0x73, 0x74, 0x6c, 0x65, 0x6d, 0x69,
	0x6c, 0x6b, 0x2f, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x2e, 0x63, 0x6f, 0x6d, 0x2e, 0x61,
	0x75, 0x2f, 0x73, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, 0x73, 0x2f, 0x67, 0x65, 0x6e, 0x2f, 0x70,
	0x72, 0x6f, 0x74, 0x6f, 0x2f, 0x67, 0x6f, 0x2f, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2f, 0x76,
	0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x3b, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x76, 0x31,
	0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0xa2, 0x02, 0x03, 0x53, 0x58, 0x58, 0xaa, 0x02, 0x0f, 0x53,
	0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0xca, 0x02,
	0x0f, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x5c, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31,
	0xe2, 0x02, 0x1b, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x5c, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68,
	0x61, 0x31, 0x5c, 0x47, 0x50, 0x42, 0x4d, 0x65, 0x74, 0x61, 0x64, 0x61, 0x74, 0x61, 0xea, 0x02,
	0x10, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x3a, 0x3a, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61,
	0x31, 0x62, 0x06, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x33,
}

var (
	file_stocks_v1alpha1_stocks_proto_rawDescOnce sync.Once
	file_stocks_v1alpha1_stocks_proto_rawDescData = file_stocks_v1alpha1_stocks_proto_rawDesc
)

func file_stocks_v1alpha1_stocks_proto_rawDescGZIP() []byte {
	file_stocks_v1alpha1_stocks_proto_rawDescOnce.Do(func() {
		file_stocks_v1alpha1_stocks_proto_rawDescData = protoimpl.X.CompressGZIP(file_stocks_v1alpha1_stocks_proto_rawDescData)
	})
	return file_stocks_v1alpha1_stocks_proto_rawDescData
}

var file_stocks_v1alpha1_stocks_proto_msgTypes = make([]protoimpl.MessageInfo, 4)
var file_stocks_v1alpha1_stocks_proto_goTypes = []interface{}{
	(*Stock)(nil),                 // 0: stocks.v1alpha1.Stock
	(*TimeSeriesData)(nil),        // 1: stocks.v1alpha1.TimeSeriesData
	(*TimeSeriesPoint)(nil),       // 2: stocks.v1alpha1.TimeSeriesPoint
	(*StockDetails)(nil),          // 3: stocks.v1alpha1.StockDetails
	(*timestamppb.Timestamp)(nil), // 4: google.protobuf.Timestamp
}
var file_stocks_v1alpha1_stocks_proto_depIdxs = []int32{
	2, // 0: stocks.v1alpha1.TimeSeriesData.points:type_name -> stocks.v1alpha1.TimeSeriesPoint
	4, // 1: stocks.v1alpha1.TimeSeriesPoint.timestamp:type_name -> google.protobuf.Timestamp
	1, // 2: stocks.v1alpha1.StockDetails.time_series_data:type_name -> stocks.v1alpha1.TimeSeriesData
	3, // [3:3] is the sub-list for method output_type
	3, // [3:3] is the sub-list for method input_type
	3, // [3:3] is the sub-list for extension type_name
	3, // [3:3] is the sub-list for extension extendee
	0, // [0:3] is the sub-list for field type_name
}

func init() { file_stocks_v1alpha1_stocks_proto_init() }
func file_stocks_v1alpha1_stocks_proto_init() {
	if File_stocks_v1alpha1_stocks_proto != nil {
		return
	}
	if !protoimpl.UnsafeEnabled {
		file_stocks_v1alpha1_stocks_proto_msgTypes[0].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*Stock); i {
			case 0:
				return &v.state
			case 1:
				return &v.sizeCache
			case 2:
				return &v.unknownFields
			default:
				return nil
			}
		}
		file_stocks_v1alpha1_stocks_proto_msgTypes[1].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*TimeSeriesData); i {
			case 0:
				return &v.state
			case 1:
				return &v.sizeCache
			case 2:
				return &v.unknownFields
			default:
				return nil
			}
		}
		file_stocks_v1alpha1_stocks_proto_msgTypes[2].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*TimeSeriesPoint); i {
			case 0:
				return &v.state
			case 1:
				return &v.sizeCache
			case 2:
				return &v.unknownFields
			default:
				return nil
			}
		}
		file_stocks_v1alpha1_stocks_proto_msgTypes[3].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*StockDetails); i {
			case 0:
				return &v.state
			case 1:
				return &v.sizeCache
			case 2:
				return &v.unknownFields
			default:
				return nil
			}
		}
	}
	type x struct{}
	out := protoimpl.TypeBuilder{
		File: protoimpl.DescBuilder{
			GoPackagePath: reflect.TypeOf(x{}).PkgPath(),
			RawDescriptor: file_stocks_v1alpha1_stocks_proto_rawDesc,
			NumEnums:      0,
			NumMessages:   4,
			NumExtensions: 0,
			NumServices:   0,
		},
		GoTypes:           file_stocks_v1alpha1_stocks_proto_goTypes,
		DependencyIndexes: file_stocks_v1alpha1_stocks_proto_depIdxs,
		MessageInfos:      file_stocks_v1alpha1_stocks_proto_msgTypes,
	}.Build()
	File_stocks_v1alpha1_stocks_proto = out.File
	file_stocks_v1alpha1_stocks_proto_rawDesc = nil
	file_stocks_v1alpha1_stocks_proto_goTypes = nil
	file_stocks_v1alpha1_stocks_proto_depIdxs = nil
}
