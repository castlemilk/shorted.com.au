// Code generated by protoc-gen-go. DO NOT EDIT.
// versions:
// 	protoc-gen-go v1.34.0
// 	protoc        (unknown)
// source: shorts/v1alpha1/shorts.proto

package shortsv1alpha1

import (
	v1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	_ "github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2/options"
	_ "google.golang.org/genproto/googleapis/api/annotations"
	protoreflect "google.golang.org/protobuf/reflect/protoreflect"
	protoimpl "google.golang.org/protobuf/runtime/protoimpl"
	reflect "reflect"
	sync "sync"
)

const (
	// Verify that this generated code is sufficiently up-to-date.
	_ = protoimpl.EnforceVersion(20 - protoimpl.MinVersion)
	// Verify that runtime/protoimpl is sufficiently up-to-date.
	_ = protoimpl.EnforceVersion(protoimpl.MaxVersion - 20)
)

// Request for Top10 RPC, specifying the period of time.
type GetTopShortsRequest struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	Period string `protobuf:"bytes,1,opt,name=period,proto3" json:"period,omitempty"`
	Limit  int32  `protobuf:"varint,2,opt,name=limit,proto3" json:"limit,omitempty"`
	Offset int32  `protobuf:"varint,3,opt,name=offset,proto3" json:"offset,omitempty"`
}

func (x *GetTopShortsRequest) Reset() {
	*x = GetTopShortsRequest{}
	if protoimpl.UnsafeEnabled {
		mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[0]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *GetTopShortsRequest) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*GetTopShortsRequest) ProtoMessage() {}

func (x *GetTopShortsRequest) ProtoReflect() protoreflect.Message {
	mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[0]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use GetTopShortsRequest.ProtoReflect.Descriptor instead.
func (*GetTopShortsRequest) Descriptor() ([]byte, []int) {
	return file_shorts_v1alpha1_shorts_proto_rawDescGZIP(), []int{0}
}

func (x *GetTopShortsRequest) GetPeriod() string {
	if x != nil {
		return x.Period
	}
	return ""
}

func (x *GetTopShortsRequest) GetLimit() int32 {
	if x != nil {
		return x.Limit
	}
	return 0
}

func (x *GetTopShortsRequest) GetOffset() int32 {
	if x != nil {
		return x.Offset
	}
	return 0
}

// Response for Top10 RPC, including time series data for each of the top 10 short positions.
type GetTopShortsResponse struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	TimeSeries []*v1alpha1.TimeSeriesData `protobuf:"bytes,1,rep,name=time_series,json=timeSeries,proto3" json:"time_series,omitempty"`
	Offset     int32                      `protobuf:"varint,2,opt,name=offset,proto3" json:"offset,omitempty"`
}

func (x *GetTopShortsResponse) Reset() {
	*x = GetTopShortsResponse{}
	if protoimpl.UnsafeEnabled {
		mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[1]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *GetTopShortsResponse) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*GetTopShortsResponse) ProtoMessage() {}

func (x *GetTopShortsResponse) ProtoReflect() protoreflect.Message {
	mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[1]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use GetTopShortsResponse.ProtoReflect.Descriptor instead.
func (*GetTopShortsResponse) Descriptor() ([]byte, []int) {
	return file_shorts_v1alpha1_shorts_proto_rawDescGZIP(), []int{1}
}

func (x *GetTopShortsResponse) GetTimeSeries() []*v1alpha1.TimeSeriesData {
	if x != nil {
		return x.TimeSeries
	}
	return nil
}

func (x *GetTopShortsResponse) GetOffset() int32 {
	if x != nil {
		return x.Offset
	}
	return 0
}

// Request for GetStockSummary RPC, specifying the product code.
type GetStockRequest struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode string `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"`
}

func (x *GetStockRequest) Reset() {
	*x = GetStockRequest{}
	if protoimpl.UnsafeEnabled {
		mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[2]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *GetStockRequest) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*GetStockRequest) ProtoMessage() {}

func (x *GetStockRequest) ProtoReflect() protoreflect.Message {
	mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[2]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use GetStockRequest.ProtoReflect.Descriptor instead.
func (*GetStockRequest) Descriptor() ([]byte, []int) {
	return file_shorts_v1alpha1_shorts_proto_rawDescGZIP(), []int{2}
}

func (x *GetStockRequest) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

// Request for GetStockDetails RPC, specifying the product code.
type GetStockDetailsRequest struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode string `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"`
}

func (x *GetStockDetailsRequest) Reset() {
	*x = GetStockDetailsRequest{}
	if protoimpl.UnsafeEnabled {
		mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[3]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *GetStockDetailsRequest) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*GetStockDetailsRequest) ProtoMessage() {}

func (x *GetStockDetailsRequest) ProtoReflect() protoreflect.Message {
	mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[3]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use GetStockDetailsRequest.ProtoReflect.Descriptor instead.
func (*GetStockDetailsRequest) Descriptor() ([]byte, []int) {
	return file_shorts_v1alpha1_shorts_proto_rawDescGZIP(), []int{3}
}

func (x *GetStockDetailsRequest) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

// Request for GetStockDataRequest RPC, specifying the product code.
type GetStockDataRequest struct {
	state         protoimpl.MessageState
	sizeCache     protoimpl.SizeCache
	unknownFields protoimpl.UnknownFields

	ProductCode string `protobuf:"bytes,1,opt,name=product_code,json=productCode,proto3" json:"product_code,omitempty"`
	Period      string `protobuf:"bytes,2,opt,name=period,proto3" json:"period,omitempty"`
}

func (x *GetStockDataRequest) Reset() {
	*x = GetStockDataRequest{}
	if protoimpl.UnsafeEnabled {
		mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[4]
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		ms.StoreMessageInfo(mi)
	}
}

func (x *GetStockDataRequest) String() string {
	return protoimpl.X.MessageStringOf(x)
}

func (*GetStockDataRequest) ProtoMessage() {}

func (x *GetStockDataRequest) ProtoReflect() protoreflect.Message {
	mi := &file_shorts_v1alpha1_shorts_proto_msgTypes[4]
	if protoimpl.UnsafeEnabled && x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

// Deprecated: Use GetStockDataRequest.ProtoReflect.Descriptor instead.
func (*GetStockDataRequest) Descriptor() ([]byte, []int) {
	return file_shorts_v1alpha1_shorts_proto_rawDescGZIP(), []int{4}
}

func (x *GetStockDataRequest) GetProductCode() string {
	if x != nil {
		return x.ProductCode
	}
	return ""
}

func (x *GetStockDataRequest) GetPeriod() string {
	if x != nil {
		return x.Period
	}
	return ""
}

var File_shorts_v1alpha1_shorts_proto protoreflect.FileDescriptor

var file_shorts_v1alpha1_shorts_proto_rawDesc = []byte{
	0x0a, 0x1c, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2f, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61,
	0x31, 0x2f, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x12, 0x0f,
	0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x1a,
	0x1c, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x2f, 0x61, 0x70, 0x69, 0x2f, 0x61, 0x6e, 0x6e, 0x6f,
	0x74, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x73, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x1a, 0x2e, 0x70,
	0x72, 0x6f, 0x74, 0x6f, 0x63, 0x2d, 0x67, 0x65, 0x6e, 0x2d, 0x6f, 0x70, 0x65, 0x6e, 0x61, 0x70,
	0x69, 0x76, 0x32, 0x2f, 0x6f, 0x70, 0x74, 0x69, 0x6f, 0x6e, 0x73, 0x2f, 0x61, 0x6e, 0x6e, 0x6f,
	0x74, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x73, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x1a, 0x1c, 0x73,
	0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2f, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2f, 0x73,
	0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x22, 0x5b, 0x0a, 0x13, 0x47,
	0x65, 0x74, 0x54, 0x6f, 0x70, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x52, 0x65, 0x71, 0x75, 0x65,
	0x73, 0x74, 0x12, 0x16, 0x0a, 0x06, 0x70, 0x65, 0x72, 0x69, 0x6f, 0x64, 0x18, 0x01, 0x20, 0x01,
	0x28, 0x09, 0x52, 0x06, 0x70, 0x65, 0x72, 0x69, 0x6f, 0x64, 0x12, 0x14, 0x0a, 0x05, 0x6c, 0x69,
	0x6d, 0x69, 0x74, 0x18, 0x02, 0x20, 0x01, 0x28, 0x05, 0x52, 0x05, 0x6c, 0x69, 0x6d, 0x69, 0x74,
	0x12, 0x16, 0x0a, 0x06, 0x6f, 0x66, 0x66, 0x73, 0x65, 0x74, 0x18, 0x03, 0x20, 0x01, 0x28, 0x05,
	0x52, 0x06, 0x6f, 0x66, 0x66, 0x73, 0x65, 0x74, 0x22, 0x70, 0x0a, 0x14, 0x47, 0x65, 0x74, 0x54,
	0x6f, 0x70, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x52, 0x65, 0x73, 0x70, 0x6f, 0x6e, 0x73, 0x65,
	0x12, 0x40, 0x0a, 0x0b, 0x74, 0x69, 0x6d, 0x65, 0x5f, 0x73, 0x65, 0x72, 0x69, 0x65, 0x73, 0x18,
	0x01, 0x20, 0x03, 0x28, 0x0b, 0x32, 0x1f, 0x2e, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x76,
	0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x54, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69,
	0x65, 0x73, 0x44, 0x61, 0x74, 0x61, 0x52, 0x0a, 0x74, 0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69,
	0x65, 0x73, 0x12, 0x16, 0x0a, 0x06, 0x6f, 0x66, 0x66, 0x73, 0x65, 0x74, 0x18, 0x02, 0x20, 0x01,
	0x28, 0x05, 0x52, 0x06, 0x6f, 0x66, 0x66, 0x73, 0x65, 0x74, 0x22, 0x34, 0x0a, 0x0f, 0x47, 0x65,
	0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x12, 0x21, 0x0a,
	0x0c, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f, 0x63, 0x6f, 0x64, 0x65, 0x18, 0x01, 0x20,
	0x01, 0x28, 0x09, 0x52, 0x0b, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x43, 0x6f, 0x64, 0x65,
	0x22, 0x3b, 0x0a, 0x16, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x44, 0x65, 0x74, 0x61,
	0x69, 0x6c, 0x73, 0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x12, 0x21, 0x0a, 0x0c, 0x70, 0x72,
	0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f, 0x63, 0x6f, 0x64, 0x65, 0x18, 0x01, 0x20, 0x01, 0x28, 0x09,
	0x52, 0x0b, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x43, 0x6f, 0x64, 0x65, 0x22, 0x50, 0x0a,
	0x13, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x44, 0x61, 0x74, 0x61, 0x52, 0x65, 0x71,
	0x75, 0x65, 0x73, 0x74, 0x12, 0x21, 0x0a, 0x0c, 0x70, 0x72, 0x6f, 0x64, 0x75, 0x63, 0x74, 0x5f,
	0x63, 0x6f, 0x64, 0x65, 0x18, 0x01, 0x20, 0x01, 0x28, 0x09, 0x52, 0x0b, 0x70, 0x72, 0x6f, 0x64,
	0x75, 0x63, 0x74, 0x43, 0x6f, 0x64, 0x65, 0x12, 0x16, 0x0a, 0x06, 0x70, 0x65, 0x72, 0x69, 0x6f,
	0x64, 0x18, 0x02, 0x20, 0x01, 0x28, 0x09, 0x52, 0x06, 0x70, 0x65, 0x72, 0x69, 0x6f, 0x64, 0x32,
	0xeb, 0x02, 0x0a, 0x14, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x53, 0x74, 0x6f, 0x63, 0x6b,
	0x73, 0x53, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, 0x12, 0x5b, 0x0a, 0x0c, 0x47, 0x65, 0x74, 0x54,
	0x6f, 0x70, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x12, 0x24, 0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74,
	0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x47, 0x65, 0x74, 0x54, 0x6f,
	0x70, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x1a, 0x25,
	0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31,
	0x2e, 0x47, 0x65, 0x74, 0x54, 0x6f, 0x70, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x52, 0x65, 0x73,
	0x70, 0x6f, 0x6e, 0x73, 0x65, 0x12, 0x44, 0x0a, 0x08, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63,
	0x6b, 0x12, 0x20, 0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70,
	0x68, 0x61, 0x31, 0x2e, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x52, 0x65, 0x71, 0x75,
	0x65, 0x73, 0x74, 0x1a, 0x16, 0x2e, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61,
	0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x12, 0x59, 0x0a, 0x0f, 0x47,
	0x65, 0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x44, 0x65, 0x74, 0x61, 0x69, 0x6c, 0x73, 0x12, 0x27,
	0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31,
	0x2e, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x44, 0x65, 0x74, 0x61, 0x69, 0x6c, 0x73,
	0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x1a, 0x1d, 0x2e, 0x73, 0x74, 0x6f, 0x63, 0x6b, 0x73,
	0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x53, 0x74, 0x6f, 0x63, 0x6b, 0x44,
	0x65, 0x74, 0x61, 0x69, 0x6c, 0x73, 0x12, 0x55, 0x0a, 0x0c, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f,
	0x63, 0x6b, 0x44, 0x61, 0x74, 0x61, 0x12, 0x24, 0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e,
	0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x47, 0x65, 0x74, 0x53, 0x74, 0x6f, 0x63,
	0x6b, 0x44, 0x61, 0x74, 0x61, 0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74, 0x1a, 0x1f, 0x2e, 0x73,
	0x74, 0x6f, 0x63, 0x6b, 0x73, 0x2e, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x2e, 0x54,
	0x69, 0x6d, 0x65, 0x53, 0x65, 0x72, 0x69, 0x65, 0x73, 0x44, 0x61, 0x74, 0x61, 0x42, 0xda, 0x01,
	0x0a, 0x13, 0x63, 0x6f, 0x6d, 0x2e, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x76, 0x31, 0x61,
	0x6c, 0x70, 0x68, 0x61, 0x31, 0x42, 0x0b, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x50, 0x72, 0x6f,
	0x74, 0x6f, 0x50, 0x01, 0x5a, 0x59, 0x67, 0x69, 0x74, 0x68, 0x75, 0x62, 0x2e, 0x63, 0x6f, 0x6d,
	0x2f, 0x63, 0x61, 0x73, 0x74, 0x6c, 0x65, 0x6d, 0x69, 0x6c, 0x6b, 0x2f, 0x73, 0x68, 0x6f, 0x72,
	0x74, 0x65, 0x64, 0x2e, 0x63, 0x6f, 0x6d, 0x2e, 0x61, 0x75, 0x2f, 0x73, 0x65, 0x72, 0x76, 0x69,
	0x63, 0x65, 0x73, 0x2f, 0x67, 0x65, 0x6e, 0x2f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x2f, 0x67, 0x6f,
	0x2f, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2f, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31,
	0x3b, 0x73, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x76, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0xa2,
	0x02, 0x03, 0x53, 0x58, 0x58, 0xaa, 0x02, 0x0f, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73, 0x2e, 0x56,
	0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0xca, 0x02, 0x0f, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73,
	0x5c, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0xe2, 0x02, 0x1b, 0x53, 0x68, 0x6f, 0x72,
	0x74, 0x73, 0x5c, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x5c, 0x47, 0x50, 0x42, 0x4d,
	0x65, 0x74, 0x61, 0x64, 0x61, 0x74, 0x61, 0xea, 0x02, 0x10, 0x53, 0x68, 0x6f, 0x72, 0x74, 0x73,
	0x3a, 0x3a, 0x56, 0x31, 0x61, 0x6c, 0x70, 0x68, 0x61, 0x31, 0x62, 0x06, 0x70, 0x72, 0x6f, 0x74,
	0x6f, 0x33,
}

var (
	file_shorts_v1alpha1_shorts_proto_rawDescOnce sync.Once
	file_shorts_v1alpha1_shorts_proto_rawDescData = file_shorts_v1alpha1_shorts_proto_rawDesc
)

func file_shorts_v1alpha1_shorts_proto_rawDescGZIP() []byte {
	file_shorts_v1alpha1_shorts_proto_rawDescOnce.Do(func() {
		file_shorts_v1alpha1_shorts_proto_rawDescData = protoimpl.X.CompressGZIP(file_shorts_v1alpha1_shorts_proto_rawDescData)
	})
	return file_shorts_v1alpha1_shorts_proto_rawDescData
}

var file_shorts_v1alpha1_shorts_proto_msgTypes = make([]protoimpl.MessageInfo, 5)
var file_shorts_v1alpha1_shorts_proto_goTypes = []interface{}{
	(*GetTopShortsRequest)(nil),     // 0: shorts.v1alpha1.GetTopShortsRequest
	(*GetTopShortsResponse)(nil),    // 1: shorts.v1alpha1.GetTopShortsResponse
	(*GetStockRequest)(nil),         // 2: shorts.v1alpha1.GetStockRequest
	(*GetStockDetailsRequest)(nil),  // 3: shorts.v1alpha1.GetStockDetailsRequest
	(*GetStockDataRequest)(nil),     // 4: shorts.v1alpha1.GetStockDataRequest
	(*v1alpha1.TimeSeriesData)(nil), // 5: stocks.v1alpha1.TimeSeriesData
	(*v1alpha1.Stock)(nil),          // 6: stocks.v1alpha1.Stock
	(*v1alpha1.StockDetails)(nil),   // 7: stocks.v1alpha1.StockDetails
}
var file_shorts_v1alpha1_shorts_proto_depIdxs = []int32{
	5, // 0: shorts.v1alpha1.GetTopShortsResponse.time_series:type_name -> stocks.v1alpha1.TimeSeriesData
	0, // 1: shorts.v1alpha1.ShortedStocksService.GetTopShorts:input_type -> shorts.v1alpha1.GetTopShortsRequest
	2, // 2: shorts.v1alpha1.ShortedStocksService.GetStock:input_type -> shorts.v1alpha1.GetStockRequest
	3, // 3: shorts.v1alpha1.ShortedStocksService.GetStockDetails:input_type -> shorts.v1alpha1.GetStockDetailsRequest
	4, // 4: shorts.v1alpha1.ShortedStocksService.GetStockData:input_type -> shorts.v1alpha1.GetStockDataRequest
	1, // 5: shorts.v1alpha1.ShortedStocksService.GetTopShorts:output_type -> shorts.v1alpha1.GetTopShortsResponse
	6, // 6: shorts.v1alpha1.ShortedStocksService.GetStock:output_type -> stocks.v1alpha1.Stock
	7, // 7: shorts.v1alpha1.ShortedStocksService.GetStockDetails:output_type -> stocks.v1alpha1.StockDetails
	5, // 8: shorts.v1alpha1.ShortedStocksService.GetStockData:output_type -> stocks.v1alpha1.TimeSeriesData
	5, // [5:9] is the sub-list for method output_type
	1, // [1:5] is the sub-list for method input_type
	1, // [1:1] is the sub-list for extension type_name
	1, // [1:1] is the sub-list for extension extendee
	0, // [0:1] is the sub-list for field type_name
}

func init() { file_shorts_v1alpha1_shorts_proto_init() }
func file_shorts_v1alpha1_shorts_proto_init() {
	if File_shorts_v1alpha1_shorts_proto != nil {
		return
	}
	if !protoimpl.UnsafeEnabled {
		file_shorts_v1alpha1_shorts_proto_msgTypes[0].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*GetTopShortsRequest); i {
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
		file_shorts_v1alpha1_shorts_proto_msgTypes[1].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*GetTopShortsResponse); i {
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
		file_shorts_v1alpha1_shorts_proto_msgTypes[2].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*GetStockRequest); i {
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
		file_shorts_v1alpha1_shorts_proto_msgTypes[3].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*GetStockDetailsRequest); i {
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
		file_shorts_v1alpha1_shorts_proto_msgTypes[4].Exporter = func(v interface{}, i int) interface{} {
			switch v := v.(*GetStockDataRequest); i {
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
			RawDescriptor: file_shorts_v1alpha1_shorts_proto_rawDesc,
			NumEnums:      0,
			NumMessages:   5,
			NumExtensions: 0,
			NumServices:   1,
		},
		GoTypes:           file_shorts_v1alpha1_shorts_proto_goTypes,
		DependencyIndexes: file_shorts_v1alpha1_shorts_proto_depIdxs,
		MessageInfos:      file_shorts_v1alpha1_shorts_proto_msgTypes,
	}.Build()
	File_shorts_v1alpha1_shorts_proto = out.File
	file_shorts_v1alpha1_shorts_proto_rawDesc = nil
	file_shorts_v1alpha1_shorts_proto_goTypes = nil
	file_shorts_v1alpha1_shorts_proto_depIdxs = nil
}
