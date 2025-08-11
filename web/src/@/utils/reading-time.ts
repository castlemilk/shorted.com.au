/**
 * Calculate estimated reading time for text content
 * Based on average reading speed of 200 words per minute
 */
export function calculateReadingTime(content: string): number {
  // Remove markdown syntax and HTML tags for more accurate word count
  const cleanContent = content
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`[^`]*`/g, '') // Remove inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Replace links with text only
    .replace(/[#*_~]/g, '') // Remove markdown formatting
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  const words = cleanContent.split(' ').filter(word => word.length > 0);
  const wordsPerMinute = 200;
  const readingTime = Math.ceil(words.length / wordsPerMinute);
  
  return Math.max(1, readingTime); // Minimum 1 minute
}

export function formatReadingTime(minutes: number): string {
  if (minutes === 1) {
    return '1 min read';
  }
  return `${minutes} min read`;
}