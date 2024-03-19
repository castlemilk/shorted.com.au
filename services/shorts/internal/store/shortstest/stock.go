package managementtest

import (
	"github.com/brianvoe/gofakeit/v6"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

func NewStock() *stockv1alpha1.Stock {
	return &stockv1alpha1.Stock{
		ProductCode: gofakeit.UUID(),
		Name:        gofakeit.Company(),
	}
}
