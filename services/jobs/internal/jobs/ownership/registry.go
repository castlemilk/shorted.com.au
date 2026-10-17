package ownership

import (
	"sort"
	"strings"
	"unicode"
)

// Kind is an institution's dominant business. It is decided here, once, by
// hand: a bank that files a notice is still a bank when the notice is about a
// fund it administers, and nothing infers a kind from one filing.
type Kind string

const (
	KindSuperFund       Kind = "super_fund"
	KindIndexManager    Kind = "index_manager"
	KindHedgeFund       Kind = "hedge_fund"
	KindActiveManager   Kind = "active_manager"
	KindBankBroker      Kind = "bank_broker"
	KindSovereignPublic Kind = "sovereign_public"
	KindInsurer         Kind = "insurer"
	KindCorporate       Kind = "corporate"
	KindPrivateEquity   Kind = "private_equity"
	KindOther           Kind = "other"
)

// Institution is one investor on the map.
type Institution struct {
	Slug    string
	Name    string
	Kind    Kind
	Country string
	Website string
	// Aliases are normalised phrases (normalizeName) that identify this
	// institution in a notice's section 1 name. Each is matched as whole
	// words. An alias must not be a phrase another holder's name could carry
	// ("capital group" is half of many names; "the capital group companies"
	// is one firm).
	Aliases     []string
	Description string
	// Group is the institution whose own notices include this one's
	// interests: its parent, or a 20%+ holder that files for it. A stock's
	// sums count a group once (its largest figure), because the group's
	// notice and the member's report the same shares.
	Group string
}

// registry is the curated map. Kinds:
//
//	super_fund       APRA-regulated superannuation trustees.
//	index_manager    Managers whose assets are mostly index funds and ETFs.
//	hedge_fund       Managers whose flagship strategies are long/short,
//	                 event-driven or absolute return.
//	active_manager   Long-only active managers and listed investment companies.
//	bank_broker      Banks, brokers and custodians. Their notices are mostly
//	                 securities lending (shares lent to, or held as collateral
//	                 from, short sellers) and prime brokerage, not a view.
//	sovereign_public Sovereign wealth funds and public-sector investors.
//	insurer          Life insurers.
//	private_equity   Private equity and infrastructure investors.
//	corporate        Never in this list: a holder whose name is a listed
//	                 ASX company's is a corporate holder (resolveHolder).
var registry = []Institution{
	// Superannuation.
	{Slug: "australiansuper", Name: "AustralianSuper", Kind: KindSuperFund, Country: "AU", Website: "https://www.australiansuper.com",
		Aliases: []string{"australiansuper", "australian super pty"}, Description: "Australia's largest super fund (industry fund)."},
	{Slug: "australian-retirement-trust", Name: "Australian Retirement Trust", Kind: KindSuperFund, Country: "AU", Website: "https://www.art.com.au",
		Aliases: []string{"australian retirement trust", "qsuper", "sunsuper"}, Description: "Formed from the 2022 merger of QSuper and Sunsuper."},
	{Slug: "aware-super", Name: "Aware Super", Kind: KindSuperFund, Country: "AU", Website: "https://aware.com.au",
		Aliases: []string{"aware super", "first state super"}, Description: "Public-sector and industry super fund (formerly First State Super)."},
	{Slug: "unisuper", Name: "UniSuper", Kind: KindSuperFund, Country: "AU", Website: "https://www.unisuper.com.au",
		Aliases: []string{"unisuper"}, Description: "Super fund for the higher education and research sector; manages most assets in house."},
	{Slug: "hostplus", Name: "Hostplus", Kind: KindSuperFund, Country: "AU", Website: "https://hostplus.com.au",
		Aliases: []string{"hostplus", "host plus"}, Description: "Industry super fund for hospitality, tourism and sport."},
	{Slug: "cbus", Name: "Cbus Super", Kind: KindSuperFund, Country: "AU", Website: "https://www.cbussuper.com.au",
		Aliases: []string{"cbus", "united super pty", "construction and building unions superannuation"}, Description: "Industry super fund for building and construction (trustee United Super Pty Ltd)."},
	{Slug: "hesta", Name: "HESTA", Kind: KindSuperFund, Country: "AU", Website: "https://www.hesta.com.au",
		Aliases: []string{"hesta", "h e s t australia"}, Description: "Industry super fund for health and community services."},
	{Slug: "rest", Name: "Rest", Kind: KindSuperFund, Country: "AU", Website: "https://rest.com.au",
		Aliases: []string{"retail employees superannuation"}, Description: "Retail Employees Superannuation Trust."},
	{Slug: "csc", Name: "Commonwealth Superannuation Corporation", Kind: KindSuperFund, Country: "AU", Website: "https://www.csc.gov.au",
		Aliases: []string{"commonwealth superannuation corporation"}, Description: "Trustee of the Australian Government's civilian and military super schemes."},
	{Slug: "colonial-first-state", Name: "Colonial First State", Kind: KindSuperFund, Country: "AU", Website: "https://www.cfs.com.au",
		Aliases: []string{"colonial first state investments", "avanteos investments", "superannuation and investments holdco"}, Description: "Superannuation and investment platform (FirstChoice)."},
	{Slug: "amp", Name: "AMP", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"amp limited", "amp super", "n m superannuation", "amp wealth management"}, Description: "Trustee of the AMP Super Fund."},
	{Slug: "mercer-super", Name: "Mercer Super", Kind: KindSuperFund, Country: "AU", Website: "https://www.mercer.com.au",
		Aliases: []string{"mercer superannuation", "mercer investments australia", "mercer financial advice"}, Description: "Mercer Super Trust and Mercer's Australian investment arm."},
	{Slug: "spirit-super", Name: "Spirit Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"spirit super", "motor trades association of australia superannuation"}},
	{Slug: "brighter-super", Name: "Brighter Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"brighter super", "lgiasuper"}},
	{Slug: "vision-super", Name: "Vision Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"vision super"}},
	{Slug: "equip-super", Name: "Equip Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"equipsuper", "equip super", "togethr trustees"}},
	{Slug: "caresuper", Name: "CareSuper", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"caresuper", "care super pty"}},
	{Slug: "active-super", Name: "Active Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"active super", "local government super"}},
	{Slug: "ngs-super", Name: "NGS Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"ngs super"}},
	{Slug: "telstra-super", Name: "Telstra Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"telstra super"}},
	{Slug: "legalsuper", Name: "Legalsuper", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"legalsuper", "legal super pty"}},
	{Slug: "mine-super", Name: "Mine Super", Kind: KindSuperFund, Country: "AU",
		Aliases: []string{"mine super", "mine wealth"}},

	// Sovereign and public investors.
	{Slug: "future-fund", Name: "Future Fund", Kind: KindSovereignPublic, Country: "AU", Website: "https://www.futurefund.gov.au",
		Aliases: []string{"future fund"}, Description: "Australia's sovereign wealth fund."},
	{Slug: "qic", Name: "QIC", Kind: KindSovereignPublic, Country: "AU",
		Aliases: []string{"qic limited", "queensland investment corporation"}, Description: "Queensland Government investment manager."},
	{Slug: "vfmc", Name: "Victorian Funds Management Corporation", Kind: KindSovereignPublic, Country: "AU",
		Aliases: []string{"victorian funds management corporation"}},
	{Slug: "norges-bank", Name: "Norges Bank", Kind: KindSovereignPublic, Country: "NO",
		Aliases: []string{"norges bank"}, Description: "Manages Norway's Government Pension Fund Global."},
	{Slug: "gic", Name: "GIC", Kind: KindSovereignPublic, Country: "SG",
		Aliases: []string{"gic private limited", "government of singapore investment corporation"}, Description: "Singapore's sovereign wealth fund."},
	{Slug: "temasek", Name: "Temasek", Kind: KindSovereignPublic, Country: "SG",
		Aliases: []string{"temasek holdings"}},
	{Slug: "adia", Name: "Abu Dhabi Investment Authority", Kind: KindSovereignPublic, Country: "AE",
		Aliases: []string{"abu dhabi investment authority"}},
	{Slug: "cppib", Name: "CPP Investments", Kind: KindSovereignPublic, Country: "CA",
		Aliases: []string{"canada pension plan investment board", "cpp investments"}},
	{Slug: "psp-investments", Name: "PSP Investments", Kind: KindSovereignPublic, Country: "CA",
		Aliases: []string{"public sector pension investment board", "psp investments"}},

	// Index managers.
	{Slug: "vanguard", Name: "Vanguard", Kind: KindIndexManager, Country: "US", Website: "https://www.vanguard.com.au",
		Aliases: []string{"vanguard group", "vanguard investments"}, Description: "The world's largest index fund manager (VAS, VGS)."},
	{Slug: "blackrock", Name: "BlackRock", Kind: KindIndexManager, Country: "US", Website: "https://www.blackrock.com/au",
		Aliases: []string{"blackrock"}, Description: "The world's largest asset manager; iShares ETFs (IOZ, IVV)."},
	{Slug: "state-street", Name: "State Street", Kind: KindIndexManager, Country: "US", Website: "https://www.ssga.com/au",
		Aliases: []string{"state street"}, Description: "State Street Global Advisors (SPDR ETFs, STW) and State Street Bank, a large custodian and agent lender."},
	{Slug: "betashares", Name: "Betashares", Kind: KindIndexManager, Country: "AU", Website: "https://www.betashares.com.au",
		Aliases: []string{"betashares", "beta shares"}, Description: "Australian ETF issuer (A200, NDQ)."},
	{Slug: "dimensional", Name: "Dimensional Fund Advisors", Kind: KindIndexManager, Country: "US",
		Aliases: []string{"dimensional fund advisors", "dimensional entities", "dfa australia"}, Description: "Systematic, index-like equity manager."},
	{Slug: "vaneck", Name: "VanEck", Kind: KindIndexManager, Country: "US",
		Aliases: []string{"vaneck", "van eck"}, Description: "ETF issuer (MVW, GDX)."},
	{Slug: "legal-and-general", Name: "Legal & General Investment Management", Kind: KindIndexManager, Country: "GB",
		Aliases: []string{"legal and general"}},
	{Slug: "geode", Name: "Geode Capital Management", Kind: KindIndexManager, Country: "US",
		Aliases: []string{"geode capital management"}},

	// Hedge funds.
	{Slug: "regal-partners", Name: "Regal Partners", Kind: KindHedgeFund, Country: "AU", Website: "https://www.regalpartners.com",
		Aliases: []string{"regal partners", "regal funds management", "vgi partners", "regal asian investments"}, Description: "Australian alternatives manager; long/short and resources strategies."},
	{Slug: "l1-capital", Name: "L1 Capital", Kind: KindHedgeFund, Country: "AU", Website: "https://www.l1.com.au",
		Aliases: []string{"l1 capital", "l1 group"}, Description: "Australian long/short and long-only manager."},
	{Slug: "platinum", Name: "Platinum Asset Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"platinum investment management", "platinum asset management"}},
	{Slug: "tribeca", Name: "Tribeca Investment Partners", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"tribeca investment partners"}},
	{Slug: "kardinia", Name: "Kardinia Capital", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"kardinia capital"}},
	{Slug: "firetrail", Name: "Firetrail Investments", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"firetrail investments"}},
	{Slug: "ellerston", Name: "Ellerston Capital", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"ellerston capital"}},
	{Slug: "antipodes", Name: "Antipodes Partners", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"antipodes partners"}},
	{Slug: "bronte", Name: "Bronte Capital", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"bronte capital"}},
	{Slug: "paragon", Name: "Paragon Funds Management", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"paragon funds management"}},
	{Slug: "merricks", Name: "Merricks Capital", Kind: KindHedgeFund, Country: "AU",
		Aliases: []string{"merricks capital"}},
	{Slug: "sand-grove", Name: "Sand Grove Capital", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"sand grove capital"}, Description: "Event-driven fund, active in ASX takeover targets."},
	{Slug: "tiga", Name: "Tiga Investments", Kind: KindHedgeFund, Country: "SG",
		Aliases: []string{"tiga investments"}},
	{Slug: "kite-lake", Name: "Kite Lake Capital", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"kite lake capital"}},
	{Slug: "pentwater", Name: "Pentwater Capital", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"pentwater capital"}},
	{Slug: "hbk", Name: "HBK Investments", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"hbk investments", "hbk master fund"}},
	{Slug: "davidson-kempner", Name: "Davidson Kempner", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"davidson kempner"}},
	{Slug: "polygon", Name: "Polygon Global Partners", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"polygon global partners", "polygon european"}},
	{Slug: "magnetar", Name: "Magnetar Capital", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"magnetar capital", "magnetar financial"}},
	{Slug: "laurion", Name: "Laurion Capital", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"laurion capital"}},
	{Slug: "segantii", Name: "Segantii Capital", Kind: KindHedgeFund, Country: "HK",
		Aliases: []string{"segantii"}},
	{Slug: "york-capital", Name: "York Capital Management", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"york capital management"}},
	{Slug: "westchester", Name: "Westchester Capital", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"westchester capital"}},
	{Slug: "alpine-associates", Name: "Alpine Associates", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"alpine associates"}},
	{Slug: "millennium", Name: "Millennium Management", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"millennium management", "millennium international management"}},
	{Slug: "point72", Name: "Point72", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"point72"}},
	{Slug: "elliott", Name: "Elliott Investment Management", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"elliott investment management", "elliott associates", "elliott international"}},
	{Slug: "hudson-bay", Name: "Hudson Bay Capital", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"hudson bay capital"}},
	{Slug: "linden", Name: "Linden Advisors", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"linden advisors"}},
	{Slug: "aqr", Name: "AQR Capital Management", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"aqr capital"}},
	{Slug: "marshall-wace", Name: "Marshall Wace", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"marshall wace"}},
	{Slug: "qube-rt", Name: "Qube Research & Technologies", Kind: KindHedgeFund, Country: "GB",
		Aliases: []string{"qube research and technologies"}},
	{Slug: "citadel", Name: "Citadel", Kind: KindHedgeFund, Country: "US",
		Aliases: []string{"citadel advisors", "citadel securities", "citadel global"}},

	// Active managers and listed investment companies.
	{Slug: "perpetual", Name: "Perpetual", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"perpetual limited", "perpetual investment management", "pendal", "j o hambro"}},
	{Slug: "fidelity", Name: "Fidelity", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"fmr llc", "fil limited", "fidelity international", "fidelity management", "fidelity investments"}, Description: "FMR (Fidelity Investments, US) and FIL (Fidelity International)."},
	{Slug: "paradice", Name: "Paradice Investment Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"paradice investment management"}},
	{Slug: "ausbil", Name: "Ausbil Investment Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"ausbil investment management"}},
	{Slug: "investors-mutual", Name: "Investors Mutual", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"investors mutual"}},
	{Slug: "allan-gray", Name: "Allan Gray", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"allan gray"}},
	{Slug: "schroders", Name: "Schroders", Kind: KindActiveManager, Country: "GB",
		Aliases: []string{"schroder investment management", "schroders"}},
	{Slug: "first-sentier", Name: "First Sentier Group", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"first sentier"}, Description: "Owned by Mitsubishi UFJ Trust and Banking since 2019.", Group: "mufg"},
	{Slug: "greencape", Name: "Greencape Capital", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"greencape capital"}},
	{Slug: "hyperion", Name: "Hyperion Asset Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"hyperion asset management"}},
	{Slug: "wilson-asset-management", Name: "Wilson Asset Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"wilson asset management", "wam capital"}},
	{Slug: "lazard", Name: "Lazard Asset Management", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"lazard asset management"}},
	{Slug: "martin-currie", Name: "Martin Currie", Kind: KindActiveManager, Country: "GB",
		Aliases: []string{"martin currie"}},
	{Slug: "alphinity", Name: "Alphinity Investment Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"alphinity investment management"}},
	{Slug: "spheria", Name: "Spheria Asset Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"spheria asset management"}},
	{Slug: "eley-griffiths", Name: "Eley Griffiths Group", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"eley griffiths"}},
	{Slug: "magellan", Name: "Magellan Financial Group", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"magellan financial group", "magellan asset management"}},
	{Slug: "bennelong", Name: "Bennelong Funds Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"bennelong australian equity partners", "bennelong funds management"}},
	{Slug: "yarra-capital", Name: "Yarra Capital Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"yarra capital management", "yarra funds management", "nikko asset management australia"}},
	{Slug: "maple-brown-abbott", Name: "Maple-Brown Abbott", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"maple brown abbott"}},
	{Slug: "northcape", Name: "Northcape Capital", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"northcape capital"}},
	{Slug: "selector", Name: "Selector Funds Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"selector funds management"}},
	{Slug: "solaris", Name: "Solaris Investment Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"solaris investment management"}},
	{Slug: "cooper-investors", Name: "Cooper Investors", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"cooper investors"}},
	{Slug: "ophir", Name: "Ophir Asset Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"ophir asset management"}},
	{Slug: "pinnacle", Name: "Pinnacle Investment Management", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"pinnacle investment management"}, Description: "Files for its affiliate managers (Hyperion, Antares, Metrics, Firetrail and others hold their own interests)."},
	{Slug: "challenger", Name: "Challenger (Fidante)", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"challenger limited", "fidante partners"}, Description: "Files for its Fidante affiliate managers."},
	{Slug: "insignia", Name: "Insignia Financial", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"insignia financial", "ioof holdings", "mlc investments", "mlc asset management"}},
	{Slug: "australian-ethical", Name: "Australian Ethical", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"australian ethical"}},
	{Slug: "t-rowe-price", Name: "T. Rowe Price", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"t rowe price"}},
	{Slug: "capital-group", Name: "Capital Group", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"the capital group companies", "capital research and management company", "capital research global investors", "capital international investors"}},
	{Slug: "wellington", Name: "Wellington Management", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"wellington management"}},
	{Slug: "invesco", Name: "Invesco", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"invesco"}},
	{Slug: "franklin-templeton", Name: "Franklin Templeton", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"franklin resources", "franklin templeton"}},
	{Slug: "abrdn", Name: "abrdn", Kind: KindActiveManager, Country: "GB",
		Aliases: []string{"abrdn", "aberdeen asset", "aberdeen standard"}},
	{Slug: "baillie-gifford", Name: "Baillie Gifford", Kind: KindActiveManager, Country: "GB",
		Aliases: []string{"baillie gifford"}},
	{Slug: "amundi", Name: "Amundi", Kind: KindActiveManager, Country: "FR",
		Aliases: []string{"amundi"}},
	{Slug: "ninety-one", Name: "Ninety One", Kind: KindActiveManager, Country: "GB",
		Aliases: []string{"ninety one"}},
	{Slug: "arrowstreet", Name: "Arrowstreet Capital", Kind: KindActiveManager, Country: "US",
		Aliases: []string{"arrowstreet capital"}},
	{Slug: "argo", Name: "Argo Investments", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"argo investments"}},
	{Slug: "afic", Name: "Australian Foundation Investment Company", Kind: KindActiveManager, Country: "AU",
		Aliases: []string{"australian foundation investment company"}},

	// Insurers.
	{Slug: "tal", Name: "TAL Dai-ichi Life", Kind: KindInsurer, Country: "AU",
		Aliases: []string{"tal dai ichi life", "tal daiichi life", "tal life"}},

	// Private equity and infrastructure.
	{Slug: "kkr", Name: "KKR", Kind: KindPrivateEquity, Country: "US",
		Aliases: []string{"kkr", "kohlberg kravis roberts"}},
	{Slug: "blackstone", Name: "Blackstone", Kind: KindPrivateEquity, Country: "US",
		Aliases: []string{"blackstone inc", "blackstone group", "the blackstone"}},
	{Slug: "bain-capital", Name: "Bain Capital", Kind: KindPrivateEquity, Country: "US",
		Aliases: []string{"bain capital"}},
	{Slug: "tpg", Name: "TPG", Kind: KindPrivateEquity, Country: "US",
		Aliases: []string{"tpg inc", "tpg capital", "tpg global"}},
	{Slug: "carlyle", Name: "Carlyle", Kind: KindPrivateEquity, Country: "US",
		Aliases: []string{"the carlyle group", "carlyle group"}},
	{Slug: "eqt", Name: "EQT", Kind: KindPrivateEquity, Country: "SE",
		Aliases: []string{"eqt ab", "eqt fund management"}},
	{Slug: "pacific-equity-partners", Name: "Pacific Equity Partners", Kind: KindPrivateEquity, Country: "AU",
		Aliases: []string{"pacific equity partners"}},
	{Slug: "brookfield", Name: "Brookfield", Kind: KindPrivateEquity, Country: "CA",
		Aliases: []string{"brookfield asset management", "brookfield corporation"}},

	// Banks, brokers and custodians.
	{Slug: "morgan-stanley", Name: "Morgan Stanley", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"morgan stanley"}, Group: "mufg"},
	{Slug: "mufg", Name: "Mitsubishi UFJ Financial Group", Kind: KindBankBroker, Country: "JP",
		Aliases: []string{"mitsubishi ufj financial group", "mufg"}, Description: "Holds over 20% of Morgan Stanley, so it files for Morgan Stanley's interests too, and owns First Sentier."},
	{Slug: "goldman-sachs", Name: "Goldman Sachs", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"goldman sachs"}},
	{Slug: "jpmorgan", Name: "JPMorgan Chase", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"jpmorgan", "j p morgan", "jp morgan"}},
	{Slug: "ubs", Name: "UBS", Kind: KindBankBroker, Country: "CH",
		Aliases: []string{"ubs group", "ubs ag", "ubs securities", "ubs asset management"}},
	{Slug: "citigroup", Name: "Citigroup", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"citigroup", "citibank", "citicorp"}},
	{Slug: "bank-of-america", Name: "Bank of America", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"bank of america", "merrill lynch"}},
	{Slug: "hsbc", Name: "HSBC", Kind: KindBankBroker, Country: "GB",
		Aliases: []string{"hsbc holdings"}},
	{Slug: "barclays", Name: "Barclays", Kind: KindBankBroker, Country: "GB",
		Aliases: []string{"barclays"}},
	{Slug: "bnp-paribas", Name: "BNP Paribas", Kind: KindBankBroker, Country: "FR",
		Aliases: []string{"bnp paribas"}},
	{Slug: "deutsche-bank", Name: "Deutsche Bank", Kind: KindBankBroker, Country: "DE",
		Aliases: []string{"deutsche bank"}},
	{Slug: "societe-generale", Name: "Societe Generale", Kind: KindBankBroker, Country: "FR",
		Aliases: []string{"societe generale"}},
	{Slug: "nomura", Name: "Nomura", Kind: KindBankBroker, Country: "JP",
		Aliases: []string{"nomura holdings", "nomura international"}},
	{Slug: "mizuho", Name: "Mizuho", Kind: KindBankBroker, Country: "JP",
		Aliases: []string{"mizuho"}},
	{Slug: "sumitomo-mitsui", Name: "Sumitomo Mitsui", Kind: KindBankBroker, Country: "JP",
		Aliases: []string{"sumitomo mitsui"}},
	{Slug: "jefferies", Name: "Jefferies", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"jefferies"}},
	{Slug: "bny", Name: "BNY", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"bank of new york mellon"}},
	{Slug: "northern-trust", Name: "Northern Trust", Kind: KindBankBroker, Country: "US",
		Aliases: []string{"northern trust"}},
	{Slug: "macquarie", Name: "Macquarie Group", Kind: KindBankBroker, Country: "AU",
		Aliases: []string{"macquarie group", "macquarie bank", "macquarie asset management", "macquarie investment management"}, Description: "Investment bank with a large asset manager; its notices combine both."},
	{Slug: "commonwealth-bank", Name: "Commonwealth Bank of Australia", Kind: KindBankBroker, Country: "AU",
		Aliases: []string{"commonwealth bank of australia"}},
	{Slug: "nab", Name: "National Australia Bank", Kind: KindBankBroker, Country: "AU",
		Aliases: []string{"national australia bank"}},
	{Slug: "anz", Name: "ANZ", Kind: KindBankBroker, Country: "AU",
		Aliases: []string{"australia and new zealand banking group"}},
	{Slug: "westpac", Name: "Westpac", Kind: KindBankBroker, Country: "AU",
		Aliases: []string{"westpac banking corporation"}},
}

// normalizeName lowercases a name to letters and digits separated by single
// spaces: "J.P. Morgan Chase & Co." becomes "j p morgan chase and co".
func normalizeName(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "&", " and ")
	s = strings.NewReplacer("'", "", "\u2019", "").Replace(s)
	var b strings.Builder
	space := true
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			// Fold accents the forms are inconsistent about ("Société").
			switch r {
			case '\u00e9', '\u00e8', '\u00ea':
				r = 'e'
			case '\u00fc':
				r = 'u'
			}
			b.WriteRune(r)
			space = false
			continue
		}
		if !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

// aliasIndex is every alias, longest first, so "state street" can never lose
// to a shorter alias inside it.
type aliasEntry struct {
	alias string
	inst  *Institution
}

var aliasIndex = buildAliasIndex(registry)

// nameIndex maps each institution's normalised name to it.
var nameIndex = func() map[string]*Institution {
	out := map[string]*Institution{}
	for i := range registry {
		out[normalizeName(registry[i].Name)] = &registry[i]
	}
	return out
}()

func buildAliasIndex(insts []Institution) []aliasEntry {
	var out []aliasEntry
	for i := range insts {
		for _, a := range insts[i].Aliases {
			out = append(out, aliasEntry{alias: normalizeName(a), inst: &insts[i]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return len(out[i].alias) > len(out[j].alias) })
	return out
}

// resolveInstitution returns the institution a holder's name belongs to: the
// one whose alias appears EARLIEST in the name, so "Mitsubishi UFJ Financial
// Group, Inc. (on behalf of Morgan Stanley)" is MUFG. nil when no alias
// appears.
func resolveInstitution(name string) *Institution {
	n := " " + normalizeName(name) + " "
	if strings.TrimSpace(n) == "" {
		return nil
	}
	// A holder named exactly as an institution on the map ("UBS") is it,
	// though the bare name is too short to be an alias inside other names.
	if inst := nameIndex[normalizeName(tidyHolderName(name))]; inst != nil {
		return inst
	}
	var best *Institution
	bestAt := -1
	for _, e := range aliasIndex {
		if i := strings.Index(n, " "+e.alias+" "); i >= 0 && (bestAt < 0 || i < bestAt) {
			best, bestAt = e.inst, i
		}
	}
	return best
}

// issuerBrands are the short names ASX's Investment Products report gives an
// ETF issuer, where they are not an institution's slug or name.
var issuerBrands = map[string]string{
	"ishares":     "blackrock",
	"dfa":         "dimensional",
	"statestreet": "state-street",
	"spdr":        "state-street",
}

// resolveIssuer maps an ETF issuer as ASX's report names it ("Vanguard",
// "iShares", "Hyperion / Pinnacle") to an institution. Only the first name
// counts: after the slash comes the responsible entity or distributor ("Milford
// / EQT" is Equity Trustees, the RE, not the Swedish EQT), never the manager. A
// brand is a whole issuer name: matched exactly, never inside another, because
// the report's names are short and generic.
func resolveIssuer(manager string) *Institution {
	part, _, _ := strings.Cut(manager, "/")
	key := normalizeName(part)
	if key == "" {
		return nil
	}
	if slug, ok := issuerBrands[strings.ReplaceAll(key, " ", "")]; ok {
		return institutionBySlug(slug)
	}
	for i := range registry {
		in := &registry[i]
		if key == strings.ReplaceAll(in.Slug, "-", " ") || key == normalizeName(in.Name) {
			return in
		}
	}
	return resolveInstitution(part)
}

func institutionBySlug(slug string) *Institution {
	for i := range registry {
		if registry[i].Slug == slug {
			return &registry[i]
		}
	}
	return nil
}

// institutionsInText returns the distinct institutions whose aliases appear in
// a passage, for a notice whose section 1 name could not be read.
func institutionsInText(text string) []*Institution {
	n := " " + normalizeName(text) + " "
	seen := map[string]bool{}
	var out []*Institution
	for _, e := range aliasIndex {
		if seen[e.inst.Slug] {
			continue
		}
		if strings.Contains(n, " "+e.alias+" ") {
			seen[e.inst.Slug] = true
			out = append(out, e.inst)
		}
	}
	return out
}

// dominantInstitution is the institution a notice is plainly about when its
// section 1 is an image: BlackRock files its signed form pages as scans, and
// only the annexure listing its entities has text. The winner must be named
// at least three times and three times as often as any other (a custodian
// named as registered holder, a parent named in a relevant-interest note).
func dominantInstitution(text string) *Institution {
	n := " " + normalizeName(text) + " "
	counts := map[*Institution]int{}
	for _, e := range aliasIndex {
		if c := strings.Count(n, " "+e.alias+" "); c > 0 {
			counts[e.inst] += c
		}
	}
	var best *Institution
	bestN, second := 0, 0
	for inst, c := range counts {
		switch {
		case c > bestN:
			second, best, bestN = bestN, inst, c
		case c > second:
			second = c
		}
	}
	if best == nil || bestN < 3 || bestN < 3*second {
		return nil
	}
	return best
}

// Tails that follow a holder's name in section 1 and are not part of it.
var nameTails = []string{
	" and its related bodies corporate", " and its related body corporate", " and related bodies corporate",
	" and its associates", " and its affiliates", " and affiliates", " and its subsidiaries", " and subsidiaries",
	" and its controlled entities", " and controlled entities", " and its controlled bodies corporate",
	" and each of its", " and each of the related", " on behalf of", " in its capacity as", " as trustee for",
	" as responsible entity", " (", ";",
	" and its subsidiary companies", " and each of ", " and each other entity", " and the entities listed",
	" and the other entities", " and entities listed", " - a subsidiary of", " a subsidiary of", "__",
}

// tidyHolderName cuts a section 1 name at the first boilerplate tail, so
// "JPMorgan Chase & Co. and its affiliates" is shown as "JPMorgan Chase & Co.".
func tidyHolderName(name string) string {
	s := strings.TrimSpace(name)
	lower := strings.ToLower(s)
	cut := len(s)
	for _, t := range nameTails {
		if i := strings.Index(lower, t); i > 2 && i < cut {
			cut = i
		}
	}
	s = strings.TrimSpace(s[:cut])
	return strings.TrimRight(s, " ,.:-")
}

// legalSuffixes are dropped from an unmapped holder's grouping key, so
// "Acme Capital Pty Ltd" and "Acme Capital Pty Limited" group.
var legalSuffixes = map[string]bool{
	"pty": true, "ltd": true, "limited": true, "inc": true, "llc": true, "plc": true, "lp": true,
	"llp": true, "ag": true, "sa": true, "nv": true, "bv": true, "corporation": true, "corp": true,
	"co": true, "the": true, "atf": true, "acn": true,
}

// holderKey groups an unmapped holder's notices by name.
func holderKey(name string) string {
	words := strings.Fields(normalizeName(tidyHolderName(name)))
	for len(words) > 0 && legalSuffixes[words[len(words)-1]] {
		words = words[:len(words)-1]
	}
	for len(words) > 0 && legalSuffixes[words[0]] {
		words = words[1:]
	}
	if len(words) == 0 {
		return ""
	}
	return "name:" + strings.Join(words, " ")
}
