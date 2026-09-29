import bench_gold as bg


def test_same_figure_allows_units_not_other_numbers():
    assert bg.same_figure("8927346", "8.927346")      # dollars vs millions
    assert bg.same_figure("641700", "641.7")          # thousands vs millions
    assert bg.same_figure("0.222", "22.2")            # dollars vs cents EPS
    assert not bg.same_figure("34.0", "39.4")         # underlying vs statutory
    assert not bg.same_figure("10.1", "39.4")


def test_filed_values_reads_only_the_aliases_downstream_reads():
    metrics = {
        "net_profit": [{"value_millions": "39.4"}, {"value_millions": "34.0"}],
        "npat": {"value_millions": "39.4"},
        "underlying_ebitda": {"value_millions": "68.7"},
        "eps": {"value_cents": "22.2"},
    }
    assert bg.filed_values(metrics, "net_profit") == {"39.4", "34"}
    assert bg.filed_values(metrics, "eps") == {"22.2"}
    assert bg.filed_values(metrics, "revenue") == set()
