package main

import (
	"errors"
	"fmt"
)

type derivationFamily struct {
	name string
	run  func() ([]Obs, error)
}

// runDerivationFamilies always runs every independent family. Observations
// from healthy families are returned alongside a joined error so runJob can
// persist the healthy data while still failing the collector run loudly.
func runDerivationFamilies(families ...derivationFamily) ([]Obs, error) {
	var obs []Obs
	var errs []error
	for _, family := range families {
		familyObs, err := family.run()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", family.name, err))
			continue
		}
		obs = append(obs, familyObs...)
	}
	return obs, errors.Join(errs...)
}
