// Package backtest holds the pure simulation of a strategy's execution: fills
// at the next traded open with the cost model of the execution recipe, the
// point-in-time total-return basis that prices P&L, cash dividends on unadjusted
// ex-dates, the exit and data-exclusion rules, and the metrics a run reports.
//
// Everything here is a function of its inputs. The package reads no clock,
// draws no random numbers and does no I/O, and iterates codes in sorted order,
// so a run is deterministic and two runs over the same sessions agree bit for
// bit. Prices are float64 throughout. Signals (status, pivot, breakout date,
// score, moving averages, dollar volume) are supplied by the caller, who
// computes them from the same rules the live evaluator uses; the simulator
// decides only what those signals trade.
package backtest
