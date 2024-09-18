// renders the tree component with the roadmap data

import Tree from "@/components/tree/tree";
import { PersonIcon } from "@radix-ui/react-icons";
import {
  ActivityIcon,
  AreaChart,
  BellIcon,
  ComputerIcon,
  ImageIcon,
  LineChartIcon,
  LucidePictureInPicture,
  NewspaperIcon,
  PaperclipIcon,
  RssIcon,
  UserRoundIcon,
  ViewIcon,
} from "lucide-react";
import Image from "next/image";
import Container from "~/@/components/ui/container";
import { cn } from "@/lib/utils";

const CustomImage = () => (
  <Image src="/logo.png" alt="Shorted node" width={40} height={40} />
);

// render a circle around the icon, hiding the line
const CircleWrapper = ({ children }: React.PropsWithChildren) => (
  <div className="relative">
    <div
      className="absolute inset-0"
      style={{ width: "20px", left: "50%", transform: "translateX(-50%)" }}
    ></div>
    <div className="relative flex items-center justify-center w-10 h-10 rounded-full bg-background dark:bg-background">
      {children}
    </div>
  </div>
);

const roadmapData = {
  id: "1",
  name: "Shorted",
  imageComponent: <CustomImage />,
  status: "DONE", // Add this line
  children: [
    {
      id: "1.1",
      name: "Dashboard & Analytics",
      description: "Basic charting and analytics on ASX shorts",
      imageComponent: (
        <CircleWrapper>
          <LineChartIcon className="w-6 h-6" />
        </CircleWrapper>
      ),
      status: "DONE", // Add this line
      children: [
        {
          id: "1.1.1",
          name: "Advanced charting",
          description:
            "render candlestick charts and other advanced charts such as WMA, EMA, RSI, MACD, Bollinger Bands, Ichimoku, Stochastic Osciallator, etc.",
          imageComponent: (
            <CircleWrapper>
              <AreaChart className="w-6 h-6" />
            </CircleWrapper>
          ),
        },
        {
          id: "1.1.2",
          name: "asx stock data",
          description: "show historical pricing for ASX stocks",
          imageComponent: (
            <CircleWrapper>
              <ActivityIcon className="w-6 h-6" />
            </CircleWrapper>
          ),
        },
      ],
    },
    {
      id: "1.2",
      name: "Company Metadata",
      description: "Collect metadata on ASX companies for analysis and viewing",
      imageComponent: (
        <CircleWrapper>
          <PaperclipIcon className="w-6 h-6" />
        </CircleWrapper>
      ),
      children: [
        {
          id: "1.2.1",
          name: "News and current events",
          description:
            "detailed information on news and current events for ASX companies",
          imageComponent: (
            <CircleWrapper>
              <NewspaperIcon className="w-6 h-6" />
            </CircleWrapper>
          ),
          children: [
            {
              id: "1.2.1.1",
              name: "RSS feeds and other sources",
              description:
                "streaming news and events from RSS feeds and other sources",
              imageComponent: (
                <CircleWrapper>
                  <RssIcon className="w-6 h-6" />
                </CircleWrapper>
              ),
            },
          ],
        },
      ],
    },
    {
      id: "1.3",
      name: "API Access",
      imageComponent: (
        <CircleWrapper>
          <ComputerIcon className="w-6 h-6" />
        </CircleWrapper>
      ),
      description: "API access to the Shorted data",
    },
    {
      id: "1.4",
      name: "Profiles",
      imageComponent: (
        <CircleWrapper>
          <UserRoundIcon className="w-6 h-6" />
        </CircleWrapper>
      ),
      description: "Personalised profiles for alerting, custom views, etc.",
      children: [
        {
          id: "1.4.1",
          name: "Alerting",
          description: "Alerting on ASX stocks and other assets",
          imageComponent: (
            <CircleWrapper>
              <BellIcon className="w-6 h-6" />
            </CircleWrapper>
          ),
        },
        {
          id: "1.4.1",
          name: "Custom views",
          description: "Custom dashboards on ASX stocks and other assets",
          imageComponent: (
            <CircleWrapper>
              <ImageIcon className="w-6 h-6" />
            </CircleWrapper>
          ),
        },
      ],
    },
  ],
};

const Legend = () => (
  <div className="absolute bottom-10 right-4 bg-background border border-border rounded-md p-3 shadow-md">
    <div className="text-sm font-semibold mb-2">Legend</div>
    <div className="flex items-center mb-1">
      <div className="w-4 h-0.5 bg-green-500 mr-2"></div>
      <span className="text-xs">Feature is complete</span>
    </div>
    <div className="flex items-center">
      <div className="w-4 h-0.5 bg-gray-300 mr-2"></div>
      <span className="text-xs">Future feature</span>
    </div>
  </div>
);

const Roadmap = () => {
  return (
    <Container className={cn("py-10 m-3", "relative")}>
      <Tree data={roadmapData} />
      <Legend />
    </Container>
  );
};

export default Roadmap;
