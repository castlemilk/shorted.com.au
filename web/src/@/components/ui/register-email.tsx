"use client";

import React, { useState } from "react";
import { Input } from "~/@/components/ui/input";
import { Button } from "~/@/components/ui/button";
import { Alert, AlertDescription } from "~/@/components/ui/alert";
import { registerEmail } from "~/app/actions/register";
import Image from "next/image";
const RegisterEmail = () => {
  const [email, setEmail] = useState("");
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<
    "idle" | "success" | "error" | "exists"
  >("idle");

  const validateEmail = (input: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    setIsValid(emailRegex.test(input));
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    setEmail(input);
    validateEmail(input);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setIsSubmitting(true);
    try {
      await registerEmail(email);
      setSubmitStatus("success");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 6) {
        setSubmitStatus("exists");
      } else {
        setSubmitStatus("error");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border p-6 rounded-lg">
        <div className="flex items-center mb-4">
          <Image
            src="/logo.png"
            alt="Shorted Logo"
            width={50}
            height={50}
            className="!m-1 !mr-6"
          />
          <div>
            <h2 className="text-2xl !mt-2 font-bold text-foreground">
              Subscribe to Our Newsletter
            </h2>
            <p className="text-muted-foreground">
              Stay updated with our latest updates!
            </p>
          </div>
        </div>
        <form onSubmit={handleSubmit}>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-foreground mb-2"
          >
            Email Address
          </label>
          <div className="flex space-x-2">
            <Input
              id="email"
              type="email"
              placeholder="jack@gmail.com"
              value={email}
              onChange={handleEmailChange}
              className={`flex-grow ${isValid ? "border-lime-600 dark:border-lime-400" : ""}`}
            />
            <Button
              type="submit"
              disabled={!isValid || isSubmitting}
              className="px-6"
            >
              {isSubmitting ? "Submitting..." : "Subscribe"}
            </Button>
          </div>
        </form>
      </div>
      {submitStatus === "success" && (
        <Alert variant="default" className="border-lime-600/40 bg-lime-600/10 text-lime-800 dark:text-lime-300">
          <AlertDescription>
            Successfully subscribed to the newsletter!
          </AlertDescription>
        </Alert>
      )}
      {submitStatus === "error" && (
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/10 text-destructive">
          <AlertDescription>
            An error occurred. Please try again.
          </AlertDescription>
        </Alert>
      )}
      {submitStatus === "exists" && (
        <Alert variant="destructive" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
          <AlertDescription>
            This email address is already subscribed!
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

export default RegisterEmail;
