import React from "react";
import { InfoIcon } from "lucide-react";

interface InfoProps {
  title: string;
  children: React.ReactNode;
}

const Info: React.FC<InfoProps> = ({ title, children }) => {
  return (
    <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-6 relative overflow-visible">
      <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary"></div>
      {/* Quarter circle border in top-left corner */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="28.5"
        height="34.5"
        fill="none"
        viewBox="0 0 57 69"
        preserveAspectRatio="none"
        className="absolute top-0 left-0"
      >
        <path
          fill="hsl(var(--background))"
          d="M54 0V0.716804C54 25.9434 35.0653 47.1517 10 50L0 57V0H54Z"
          className="transition: fill var(--color-swap-duration) var(--color-swap-timing-function);"
        ></path>
        <path
          fill="hsl(var(--primary))"
          d="M56.9961 4.15364C57.0809 2.49896 55.8083 1.08879 54.1536 1.00394C52.499 0.919082 51.0888 2.19168 51.0039 3.84636L56.9961 4.15364ZM9.09704 51.7557L8.49716 48.8163L9.09704 51.7557ZM6 69V59.2227H0V69H6ZM9.69692 54.6951L14.3373 53.7481L13.1375 47.8693L8.49716 48.8163L9.69692 54.6951ZM14.3373 53.7481C38.202 48.8777 55.7486 28.4783 56.9961 4.15364L51.0039 3.84636C49.8967 25.4384 34.3213 43.5461 13.1375 47.8693L14.3373 53.7481ZM6 59.2227C6 57.0268 7.54537 55.1342 9.69692 54.6951L8.49716 48.8163C3.55195 49.8255 0 54.1756 0 59.2227H6Z"
        ></path>
      </svg>
      <div className="absolute -top-4 -left-4 z-10">
        <div className="bg-background rounded-full p-2 relative">
          <InfoIcon className="w-6 h-6 text-primary" />
        </div>
      </div>
      <div className="mt-2 ml-4">
        <h4 className="text-l font-semibold text-foreground m-0">{title}</h4>
        <div className="text-foreground ">
          <p className="m-0">{children}</p>
        </div>
      </div>
    </div>
  );
};

export default Info;
