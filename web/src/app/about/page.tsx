import React from "react";
import { Eye, LineChart, BarChart, Bell } from "lucide-react";
import "./page.css"; // Import the CSS file for additional styling

const Page = () => {
  return (
    <div className="about-page bg-card text-card-foreground p-6 rounded-lg shadow-md">
      <h1 className="title text-3xl font-bold mb-4">About Short Position Stock Portfolio</h1>
      <p className="description mb-4">
        Welcome to the Short Position Stock Portfolio web app. This application
        allows users to manage and track their short positions in various
        stocks. Our goal is to provide a simple and intuitive interface for
        monitoring your investments and making informed decisions.
      </p>
      <p className="features-intro mb-2">With this app, you can:</p>
      <ul className="features-list list-disc pl-5 mb-4">
        <li className="flex items-center mb-2">
          <Eye className="mr-2 text-primary" /> View your current short positions
        </li>
        <li className="flex items-center mb-2">
          <LineChart className="mr-2 text-primary" /> Track stock performance
        </li>
        <li className="flex items-center mb-2">
          <BarChart className="mr-2 text-primary" /> Analyze market trends
        </li>
        <li className="flex items-center mb-2">
          <Bell className="mr-2 text-primary" /> Receive notifications on significant market changes
        </li>
      </ul>
      <p className="contact-info">
        We hope you find this tool useful for managing your short position
        investments. If you have any questions or feedback, please feel free to
        contact us.
      </p>
    </div>
  );
};

export default Page;
