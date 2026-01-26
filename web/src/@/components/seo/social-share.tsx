"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Twitter, Linkedin, Link2, Check } from 'lucide-react';

interface SocialShareProps {
  url: string;
  title: string;
  description?: string;
}

export function SocialShare({ url, title }: SocialShareProps) {
  const [copied, setCopied] = useState(false);

  const shareUrls = {
    twitter: `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const openShare = (platform: 'twitter' | 'linkedin') => {
    window.open(shareUrls[platform], '_blank', 'width=600,height=400');
  };

  return (
    <div className="flex items-center gap-2 py-4 border-t border-b border-gray-200">
      <span className="text-sm text-gray-600 mr-2">Share this article:</span>
      
      <Button
        variant="outline"
        size="sm"
        onClick={() => openShare('twitter')}
        className="flex items-center gap-2"
      >
        <Twitter className="h-4 w-4" />
        Tweet
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => openShare('linkedin')}
        className="flex items-center gap-2"
      >
        <Linkedin className="h-4 w-4" />
        Share
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={copyToClipboard}
        className="flex items-center gap-2"
      >
        {copied ? (
          <>
            <Check className="h-4 w-4 text-green-600" />
            Copied!
          </>
        ) : (
          <>
            <Link2 className="h-4 w-4" />
            Copy Link
          </>
        )}
      </Button>
    </div>
  );
}