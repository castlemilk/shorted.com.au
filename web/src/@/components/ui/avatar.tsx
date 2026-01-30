import Image from "next/image";

type Props = {
  name: string;
  picture: string;
  size?: number;
};

const Avatar = ({ name, picture, size = 40 }: Props) => {
  return (
    <div
      className="relative flex items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      <Image
        src={picture}
        className="object-cover"
        fill
        sizes={`${size}px`}
        alt={name}
      />
    </div>
  );
};

export default Avatar;
