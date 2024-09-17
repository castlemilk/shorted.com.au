import { type ClassValue } from "clsx";
import { cn } from "~/@/lib/utils";

type Props = {
  className?: ClassValue;
  children?: React.ReactNode;
};

const Container = ({ children, className }: Props) => {
  return (
    <div className={cn("container mx-auto px-5", className)}>{children}</div>
  );
};

export default Container;
