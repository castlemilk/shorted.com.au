import * as React from "react";
import { useForm } from "react-hook-form";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Button,
} from "shorted";

/**
 * The canonical field, wired to a real `useForm` control: FormItem stacks
 * FormLabel, the FormControl-slotted Input, and FormDescription.
 */
export const Default = () => {
  const form = useForm({ defaultValues: { code: "BHP" } });
  return (
    <Form {...form}>
      <form className="w-72 space-y-6">
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>ASX code</FormLabel>
              <FormControl>
                <Input placeholder="BHP" {...field} />
              </FormControl>
              <FormDescription>
                The three-letter code ASIC reports against.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" size="sm">
          Add to watchlist
        </Button>
      </form>
    </Form>
  );
};

/**
 * Invalid state — the error is seeded through `useForm({ errors })`, so
 * FormLabel turns destructive and FormMessage renders the message.
 */
export const WithError = () => {
  const form = useForm({
    defaultValues: { code: "BHPX" },
    errors: {
      code: {
        type: "manual",
        message: "BHPX is not a listed ASX code.",
      },
    },
  });
  return (
    <Form {...form}>
      <form className="w-72 space-y-6">
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>ASX code</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>
                The three-letter code ASIC reports against.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
};

/** A Select as the control — FormControl slots onto the SelectTrigger. */
export const WithSelect = () => {
  const form = useForm({ defaultValues: { period: "6m" } });
  return (
    <Form {...form}>
      <form className="w-72 space-y-6">
        <FormField
          control={form.control}
          name="period"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Reporting period</FormLabel>
              <Select defaultValue={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a period" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="1m">1 month</SelectItem>
                  <SelectItem value="3m">3 months</SelectItem>
                  <SelectItem value="6m">6 months</SelectItem>
                  <SelectItem value="1y">1 year</SelectItem>
                </SelectContent>
              </Select>
              <FormDescription>
                Window used for the short interest trend.
              </FormDescription>
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
};

/** A boolean field: the switch sits on the trailing edge of a bordered row. */
export const WithSwitch = () => {
  const form = useForm({ defaultValues: { alerts: true } });
  return (
    <Form {...form}>
      <form className="w-80 space-y-6">
        <FormField
          control={form.control}
          name="alerts"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border p-4">
              <div className="space-y-1">
                <FormLabel>ASIC report alerts</FormLabel>
                <FormDescription>
                  Email me when a new daily report lands.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
};
