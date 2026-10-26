import Image from "next/image";

type Props = {
  name: string;
  picture: string;
  size?: number;
};

// A fixed width and height, not `fill` + `sizes`: next/image then emits a
// 1x/2x srcset (48w and 96w at 36px) instead of every configured width, 16
// candidates up to 3840w. `h-full w-full` keeps the box square over
// preflight's `height: auto`, so object-cover still crops a non-square photo.
const Avatar = ({ name, picture, size = 40 }: Props) => {
  return (
    <div
      className="relative flex items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      <Image
        src={picture}
        className="h-full w-full object-cover"
        width={size}
        height={size}
        alt={name}
      />
    </div>
  );
};

export default Avatar;
