/**
 * Enriched Company Metadata Types
 * 
 * Data structure for GPT-5 enriched company information
 * stored in the company-metadata PostgreSQL table
 */

export interface Person {
  name: string;
  role: string;
  bio: string;
}

export interface FinancialReport {
  title: string;
  date: string | null;
  type: string;
  url: string;
  source?: string | null;
  gcs_url?: string | null;
  depth?: number;
}

export interface SocialMediaLinks {
  linkedin?: string | null;
  twitter?: string | null;
  facebook?: string | null;
  youtube?: string | null;
  website?: string | null;
}

export interface FinancialStatements {
  stock_code: string;
  success: boolean;
  annual: {
    income_statement?: Record<string, Record<string, number | null>>;
    balance_sheet?: Record<string, Record<string, number | null>>;
    cash_flow?: Record<string, Record<string, number | null>>;
  };
  quarterly?: {
    income_statement?: Record<string, Record<string, number | null>>;
    balance_sheet?: Record<string, Record<string, number | null>>;
    cash_flow?: Record<string, Record<string, number | null>>;
  };
  info: {
    market_cap?: number;
    current_price?: number;
    pe_ratio?: number;
    eps?: number;
    dividend_yield?: number;
    beta?: number;
    week_52_high?: number;
    week_52_low?: number;
    volume?: number;
    employee_count?: number;
    sector?: string;
    industry?: string;
  };
  error?: string | null;
}

export interface EnrichedCompanyMetadata {
  stock_code: string;
  company_name: string;
  industry: string | null;
  logo_url: string | null;
  logo_gcs_url: string | null;
  website: string | null;
  description: string | null;
  
  // GPT-5 Enriched Fields
  tags: string[];
  enhanced_summary: string | null;
  company_history: string | null;
  key_people: Person[];
  financial_reports: FinancialReport[];
  competitive_advantages: string | null;
  risk_factors: string[];
  recent_developments: string | null;
  social_media_links: SocialMediaLinks;
  
  // Yahoo Finance Data
  financial_statements: FinancialStatements | null;
  
  // Metadata
  enrichment_status: 'pending' | 'completed' | 'failed';
  enrichment_date: string | null;
  enrichment_error: string | null;
}

/**
 * Simplified view for listings/cards
 */
export interface CompanyMetadataSummary {
  stock_code: string;
  company_name: string;
  industry: string | null;
  logo_gcs_url: string | null;
  tags: string[];
  enhanced_summary: string | null;
  enrichment_status: 'pending' | 'completed' | 'failed';
}

/**
 * API Response wrapper
 */
export interface CompanyMetadataResponse {
  success: boolean;
  data?: EnrichedCompanyMetadata;
  error?: string;
}

