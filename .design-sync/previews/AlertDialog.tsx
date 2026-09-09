import * as React from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "shorted";

/**
 * The canonical destructive confirm, forced `open` so the modal renders
 * statically. Cancel is an outline button, Action the default filled one.
 */
export const Default = () => (
  <AlertDialog open>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Remove PLS from your watchlist?</AlertDialogTitle>
        <AlertDialogDescription>
          Pilbara Minerals will stop appearing on your dashboard and any short
          interest alerts you set for it will be deleted.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Keep watching</AlertDialogCancel>
        <AlertDialogAction>Remove</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * A genuinely irreversible action: the Action button takes the destructive
 * button styling so the consequence is legible before the click.
 */
export const DestructiveAction = () => (
  <AlertDialog open>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
        <AlertDialogDescription>
          Key <span className="font-medium text-foreground">sk_live_9f21…c4a7</span>{" "}
          has made 8,412 requests this month. Revoking takes effect immediately
          and cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
          Revoke key
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/** A longer body: extra content sits between the header and the footer. */
export const WithDetail = () => (
  <AlertDialog open>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Cancel your Premium subscription?</AlertDialogTitle>
        <AlertDialogDescription>
          Your plan stays active until the end of the current billing period.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="space-y-1 border-y py-3 text-sm text-muted-foreground">
        <li>· 12 watchlist alerts stop firing on 30 September</li>
        <li>· Screener exports revert to the 50-row free limit</li>
        <li>· Weekly report archive access ends immediately</li>
      </ul>
      <AlertDialogFooter>
        <AlertDialogCancel>Stay on Premium</AlertDialogCancel>
        <AlertDialogAction>Cancel subscription</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
