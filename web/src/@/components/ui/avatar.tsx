import Image from "next/image";

type Props = {
  name: string;
  picture: string;
};

const Avatar = ({ name, picture }: Props) => {
  return (
    <div className="flex items-center">
      <Image
        src={picture}
        className="w-10 h-10 rounded-full"
        width={42}
        height={42}
        alt={name}
      />
    </div>
  );
};

export default Avatar;
