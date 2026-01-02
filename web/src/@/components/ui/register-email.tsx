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
      <div className="bg-gray-800 p-6 rounded-lg">
        <div className="flex items-center mb-4">
          <Image
            src="/logo.png"
            alt="Shorted Logo"
            width={50}
            height={50}
            className="!m-1 !mr-6"
          />
          <div>
            <h2 className="text-2xl !mt-2 font-bold text-white">
              Subscribe to Our Newsletter
            </h2>
            <p className="text-gray-400">
              Stay updated with our latest updates!
            </p>
          </div>
        </div>
        <form onSubmit={handleSubmit}>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-300 mb-2"
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
              className={`flex-grow ${isValid ? "border-green-500" : ""} bg-gray-700 text-white`}
            />
            <Button
              type="submit"
              disabled={!isValid || isSubmitting}
              className="bg-blue-500 hover:bg-blue-600 text-white px-6"
            >
              {isSubmitting ? "Submitting..." : "Subscribe"}
            </Button>
          </div>
        </form>
      </div>
      {submitStatus === "success" && (
        <Alert variant="default" className="bg-green-800 text-white">
          <AlertDescription>
            Successfully subscribed to the newsletter!
          </AlertDescription>
        </Alert>
      )}
      {submitStatus === "error" && (
        <Alert variant="destructive" className="bg-red-800 text-white">
          <AlertDescription>
            An error occurred. Please try again.
          </AlertDescription>
        </Alert>
      )}
      {submitStatus === "exists" && (
        <Alert variant="destructive" className="bg-yellow-800 text-white">
          <AlertDescription>
            This email address is already subscribed!
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

export default RegisterEmail;
