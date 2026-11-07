// Command btprof profiles the backtest's Disclose offline. It reads the inputs a
// backtest batch reads once, from a database, into a file, and then replays
// Disclose on them as often as needed, with CPU and heap profiles. The replay
// prints the run's input and output hashes, so a change that is meant to leave
// the results alone can be checked against a published run (build with
// GOARCH=amd64 to compare with the cluster's figures: arm64 may fuse a*b+c).
//
//	DATABASE_URL=... go run ./pkg/strategy/backtest/btprof dump -out inputs.gob
//	go run ./pkg/strategy/backtest/btprof run -in inputs.gob -strategy minervini-trend-template -cpu cpu.pprof
package main

import (
	"bufio"
	"context"
	"encoding/gob"
	"flag"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"syscall"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

type dumpFile struct {
	WindowEnd civil.Date
	In        *backtest.MemoryInputs
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: btprof dump|run [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "dump":
		err = dump(os.Args[2:])
	case "run":
		err = run(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "btprof:", err)
		os.Exit(1)
	}
}

func dump(args []string) error {
	fs := flag.NewFlagSet("dump", flag.ExitOnError)
	out := fs.String("out", "inputs.gob", "file to write")
	_ = fs.Parse(args)
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL is not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	end, ok, err := pgsource.BacktestWindowEnd(ctx, tx)
	if err != nil || !ok {
		return fmt.Errorf("window end: ok=%v err=%v", ok, err)
	}
	t0 := time.Now()
	in, err := pgsource.LoadBacktestInputs(ctx, tx, end)
	if err != nil {
		return fmt.Errorf("load: %w", err)
	}
	fmt.Printf("loaded %d codes to %s in %s\n", len(in.BarsByCode), end, time.Since(t0).Round(time.Millisecond))
	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	if err := gob.NewEncoder(w).Encode(dumpFile{WindowEnd: end, In: in}); err != nil {
		return fmt.Errorf("encode: %w", err)
	}
	if err := w.Flush(); err != nil {
		return err
	}
	return f.Close()
}

func run(args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	inPath := fs.String("in", "inputs.gob", "dump to replay")
	strategy := fs.String("strategy", "minervini-trend-template", "strategy id")
	cpu := fs.String("cpu", "", "CPU profile to write")
	mem := fs.String("mem", "", "heap profile to write (after Disclose, before GC of its result)")
	liveFromArg := fs.String("live-from", "2026-11-06", "the version's live_from")
	_ = fs.Parse(args)

	t0 := time.Now()
	f, err := os.Open(*inPath)
	if err != nil {
		return err
	}
	var d dumpFile
	if err := gob.NewDecoder(bufio.NewReaderSize(f, 1<<20)).Decode(&d); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	_ = f.Close()
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	fmt.Printf("decoded %d codes (window end %s) in %s; heap in use %d MiB\n",
		len(d.In.BarsByCode), d.WindowEnd, time.Since(t0).Round(time.Millisecond), ms.HeapInuse>>20)

	var reg *spec.Registered
	for _, v := range spec.Registry() {
		if v.Live && v.Label != "v0" && v.Recipe != nil && v.Spec.StrategyID == *strategy {
			v := v
			reg = &v
		}
	}
	if reg == nil {
		return fmt.Errorf("no live recipe-bearing version for %s", *strategy)
	}
	liveFrom, err := civil.ParseDate(*liveFromArg)
	if err != nil {
		return err
	}
	if *cpu != "" {
		pf, err := os.Create(*cpu)
		if err != nil {
			return err
		}
		if err := pprof.StartCPUProfile(pf); err != nil {
			return err
		}
		defer pprof.StopCPUProfile()
	}
	t1 := time.Now()
	disc, base, err := backtest.Disclose(d.In, reg.Spec, *reg.Recipe, liveFrom, nil, d.WindowEnd, "btprof", "")
	if err != nil {
		return fmt.Errorf("disclose: %w", err)
	}
	elapsed := time.Since(t1)
	if *cpu != "" {
		pprof.StopCPUProfile()
	}
	if *mem != "" {
		mf, err := os.Create(*mem)
		if err != nil {
			return err
		}
		if err := pprof.WriteHeapProfile(mf); err != nil {
			return err
		}
		_ = mf.Close()
	}
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	maxrss := int64(ru.Maxrss)
	if runtime.GOOS != "darwin" {
		maxrss *= 1024
	}
	fmt.Printf("%s %s: Disclose %s; sessions %d, trades %d; input %s output %s run key %s; peak RSS %d MiB\n",
		reg.Label, reg.Recipe.ID, elapsed.Round(time.Millisecond), len(base.Sessions), len(base.Trades),
		disc.Identity.InputHash, disc.Identity.OutputHash, disc.Identity.RunKey, maxrss>>20)
	for _, s := range disc.Sensitivity.Runs {
		fmt.Printf("  sens %-20s applies=%-5v cagr=%.17g (has %v) mdd=%.17g trades=%d\n",
			s.ID, s.Applies, s.Figures.CAGR, s.Figures.HasCAGR, s.Figures.MaxDrawdown, s.Figures.ClosedTrades)
	}
	return nil
}
