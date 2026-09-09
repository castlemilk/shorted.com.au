import * as React from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Badge, Button } from "shorted";

/** The full slot set: header (title + description), content, footer. */
export const Default = () => (
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>Pilbara Minerals</CardTitle>
      <CardDescription>PLS · Materials · ASX 200</CardDescription>
    </CardHeader>
    <CardContent>
      <p className="text-sm text-muted-foreground">
        The most shorted stock on the ASX, with 19.4% of shares on issue held
        short as at the latest ASIC report.
      </p>
    </CardContent>
    <CardFooter className="gap-2">
      <Button size="sm">Open</Button>
      <Button size="sm" variant="outline">Watch</Button>
    </CardFooter>
  </Card>
);

/** Header + content only — the common compact form. */
export const Compact = () => (
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>Short interest</CardTitle>
      <CardDescription>Rolling 3 months</CardDescription>
    </CardHeader>
    <CardContent className="text-2xl font-semibold">19.4%</CardContent>
  </Card>
);

/** Composed with Badge — how cards carry status in this system. */
export const WithBadges = () => (
  <Card className="max-w-sm">
    <CardHeader>
      <div className="flex items-center justify-between">
        <CardTitle>BHP Group</CardTitle>
        <Badge variant="secondary">0.8% short</Badge>
      </div>
      <CardDescription>BHP · Materials</CardDescription>
    </CardHeader>
    <CardContent className="text-sm text-muted-foreground">
      Short interest is flat against the sector median.
    </CardContent>
  </Card>
);
