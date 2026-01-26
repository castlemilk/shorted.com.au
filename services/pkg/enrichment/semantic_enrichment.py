"""
Semantic Company Enrichment

ChunkHound-inspired approach: Extract high-signal content, minimize tokens.

Key strategies:
1. Structured extraction - only pull what we need
2. Two-phase enrichment - cheap validation, expensive detail
3. Batch processing - multiple companies per API call
4. Caching - avoid re-enriching unchanged data
"""
import json
import hashlib
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
from datetime import datetime


@dataclass
class CompanySignals:
    """Minimal signals needed for enrichment - optimized for token efficiency."""
    stock_code: str
    company_name: str
    industry: str
    website: str
    existing_summary: str = ""
    
    def to_compact_string(self) -> str:
        """Convert to minimal token representation."""
        return f"{self.stock_code}|{self.company_name}|{self.industry}|{self.website}"
    
    def content_hash(self) -> str:
        """Hash for caching - detect if company data changed."""
        content = f"{self.company_name}{self.industry}{self.website}"
        return hashlib.md5(content.encode()).hexdigest()[:12]


# ============================================================
# Optimized Prompts - Minimize input tokens
# ============================================================

BATCH_SYSTEM_PROMPT = """You are a financial analyst. Return ONLY valid JSON array.
For each company, provide: tags (5), summary (2 sentences), risks (3).
Be specific. No generic content."""

def create_batch_prompt(companies: List[CompanySignals], max_companies: int = 10) -> str:
    """
    Create a batch prompt for multiple companies.
    
    Token comparison:
    - Single company prompt: ~200 tokens
    - 10 company batch prompt: ~400 tokens (50% savings)
    """
    batch = companies[:max_companies]
    
    # Compact format - minimize tokens
    lines = ["Companies to analyze:"]
    for c in batch:
        lines.append(f"- {c.stock_code}: {c.company_name} ({c.industry}) - {c.website}")
    
    lines.append("")
    lines.append("Return JSON array with objects for each stock_code:")
    lines.append('{"stock_code": "XXX", "tags": [...], "summary": "...", "risks": [...]}')
    
    return "\n".join(lines)


# ============================================================
# Two-Phase Enrichment
# ============================================================

PHASE1_PROMPT = """Classify these companies into categories (tech/mining/finance/services/other).
Return JSON: {"classifications": {"STOCK": "category", ...}}
Companies: {companies}"""

def phase1_classify(companies: List[CompanySignals]) -> Dict[str, str]:
    """
    Phase 1: Cheap classification using GPT-4o-mini.
    ~100 tokens in, ~50 tokens out = ~$0.0001 per batch
    """
    # This would call GPT-4o-mini
    # For now, return a mock implementation
    return {c.stock_code: "other" for c in companies}


PHASE2_PROMPTS = {
    "tech": """Tech company analysis for {company}. Focus on: products, tech stack, IP, market position.
Return: {"tags": [...], "summary": "...", "tech_details": {...}}""",
    
    "mining": """Mining company analysis for {company}. Focus on: resources, locations, permits, exploration.
Return: {"tags": [...], "summary": "...", "mining_details": {...}}""",
    
    "finance": """Finance company analysis for {company}. Focus on: services, AUM, regulatory status.
Return: {"tags": [...], "summary": "...", "finance_details": {...}}""",
    
    "other": """Company analysis for {company}. Focus on: core business, market position.
Return: {"tags": [...], "summary": "...", "risks": [...]}""",
}


# ============================================================
# Incremental Enrichment with Caching
# ============================================================

class EnrichmentCache:
    """
    Simple file-based cache for enrichment results.
    Avoids re-enriching companies that haven't changed.
    """
    
    def __init__(self, cache_path: str = "enrichment_cache.json"):
        self.cache_path = cache_path
        self._cache: Dict[str, Dict] = {}
        self._load()
    
    def _load(self):
        try:
            with open(self.cache_path, 'r') as f:
                self._cache = json.load(f)
        except:
            self._cache = {}
    
    def _save(self):
        with open(self.cache_path, 'w') as f:
            json.dump(self._cache, f, indent=2)
    
    def get(self, company: CompanySignals) -> Optional[Dict]:
        """Get cached enrichment if company data hasn't changed."""
        key = company.stock_code
        if key not in self._cache:
            return None
        
        cached = self._cache[key]
        if cached.get('content_hash') != company.content_hash():
            return None  # Company data changed, need re-enrichment
        
        return cached.get('enrichment')
    
    def set(self, company: CompanySignals, enrichment: Dict):
        """Cache enrichment result."""
        self._cache[company.stock_code] = {
            'content_hash': company.content_hash(),
            'enrichment': enrichment,
            'cached_at': datetime.now().isoformat(),
        }
        self._save()
    
    def get_stats(self) -> Dict[str, int]:
        """Get cache statistics."""
        return {
            'total_cached': len(self._cache),
            'cache_size_kb': len(json.dumps(self._cache)) // 1024,
        }


# ============================================================
# Token Usage Estimator
# ============================================================

def estimate_tokens(text: str) -> int:
    """Rough token estimate (4 chars per token average)."""
    return len(text) // 4


def estimate_batch_cost(
    companies: List[CompanySignals],
    model: str = "gpt-4o-mini",
    batch_size: int = 10
) -> Dict[str, float]:
    """
    Estimate API costs for enrichment.
    
    Pricing (as of 2024):
    - gpt-4o: $2.50/1M input, $10/1M output
    - gpt-4o-mini: $0.15/1M input, $0.60/1M output
    """
    pricing = {
        "gpt-4o": {"input": 2.50, "output": 10.0},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    }
    
    prices = pricing.get(model, pricing["gpt-4o-mini"])
    
    # Estimate tokens
    num_batches = (len(companies) + batch_size - 1) // batch_size
    
    # Per batch: ~400 input tokens, ~1500 output tokens
    input_tokens = num_batches * 400
    output_tokens = num_batches * 1500 * min(batch_size, len(companies))
    
    input_cost = (input_tokens / 1_000_000) * prices["input"]
    output_cost = (output_tokens / 1_000_000) * prices["output"]
    
    return {
        "model": model,
        "companies": len(companies),
        "batches": num_batches,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "input_cost": input_cost,
        "output_cost": output_cost,
        "total_cost": input_cost + output_cost,
    }


# ============================================================
# Demo
# ============================================================

if __name__ == "__main__":
    # Example companies
    companies = [
        CompanySignals("4DS", "4DS Memory Limited", "Semiconductors", "http://www.4dsmemory.com"),
        CompanySignals("GAL", "Galileo Mining Ltd", "Materials", "http://www.galileomining.com.au"),
        CompanySignals("ASB", "Austal Limited", "Capital Goods", "http://www.austal.com"),
    ]
    
    print("=== Token Usage Estimates ===\n")
    
    for model in ["gpt-4o", "gpt-4o-mini"]:
        estimate = estimate_batch_cost(companies * 100, model=model)  # Simulate 300 companies
        print(f"{model}:")
        print(f"  Companies: {estimate['companies']}")
        print(f"  Batches: {estimate['batches']}")
        print(f"  Input tokens: {estimate['input_tokens']:,}")
        print(f"  Output tokens: {estimate['output_tokens']:,}")
        print(f"  Total cost: ${estimate['total_cost']:.2f}")
        print()
    
    print("=== Batch Prompt Example ===\n")
    prompt = create_batch_prompt(companies)
    print(prompt)
    print(f"\nEstimated tokens: {estimate_tokens(prompt)}")
