import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Badge } from "~/@/components/ui/badge";
import type { EnrichedCompanyMetadata } from "~/@/types/company-metadata";
import { Building2, TrendingUp, AlertTriangle, Newspaper } from "lucide-react";

interface CompanyOverviewProps {
  data: EnrichedCompanyMetadata;
}

export function CompanyOverview({ data }: CompanyOverviewProps) {
  return (
    <div className="space-y-6">
      {/* Tags */}
      {data.tags && data.tags.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Industry & Focus
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {data.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="px-3 py-1 text-sm"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Enhanced Summary */}
      {data.enhanced_summary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Company Overview</CardTitle>
            <CardDescription>AI-generated company summary</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {data.enhanced_summary}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Company History */}
      {data.company_history && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Company History</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {data.company_history}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Competitive Advantages */}
      {data.competitive_advantages && (
        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-600" />
              Competitive Advantages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {data.competitive_advantages}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Risk Factors */}
      {data.risk_factors && data.risk_factors.length > 0 && (
        <Card className="border-l-4 border-l-amber-500">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Risk Factors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.risk_factors.map((risk, index) => (
                <li key={index} className="text-sm text-muted-foreground flex items-start">
                  <span className="mr-2 text-amber-600">•</span>
                  <span>{risk}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Recent Developments */}
      {data.recent_developments && (
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Newspaper className="h-5 w-5 text-blue-600" />
              Recent Developments
            </CardTitle>
            <CardDescription>Last 6 months</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {data.recent_developments}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

