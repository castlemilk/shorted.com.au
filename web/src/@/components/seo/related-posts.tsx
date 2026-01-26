import Link from 'next/link';
import { getAllPosts } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { calculateReadingTime, formatReadingTime } from '@/utils/reading-time';

interface RelatedPostsProps {
  currentSlug: string;
  maxPosts?: number;
}

export function RelatedPosts({ currentSlug, maxPosts = 3 }: RelatedPostsProps) {
  const allPosts = getAllPosts();
  
  // Filter out current post and get related posts
  const relatedPosts = allPosts
    .filter(post => post.slug !== currentSlug)
    .slice(0, maxPosts);

  if (relatedPosts.length === 0) {
    return null;
  }

  return (
    <section className="mt-16 pt-8 border-t border-gray-200">
      <h2 className="text-2xl font-bold mb-6">Related Articles</h2>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {relatedPosts.map((post) => (
          <Card key={post.slug} className="p-6 hover:shadow-lg transition-shadow">
            <article>
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <time dateTime={post.date}>
                    {new Date(post.date).toLocaleDateString('en-AU', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </time>
                  <span>•</span>
                  <span>{formatReadingTime(calculateReadingTime(post.content))}</span>
                </div>
                
                <h3 className="text-lg font-semibold line-clamp-2">
                  <Link 
                    href={`/blog/${post.slug}`}
                    className="hover:text-blue-600 transition-colors"
                  >
                    {post.title}
                  </Link>
                </h3>
                
                {post.excerpt && (
                  <p className="text-gray-600 text-sm line-clamp-3">
                    {post.excerpt}
                  </p>
                )}
                
                <div className="pt-2">
                  <Link 
                    href={`/blog/${post.slug}`}
                    className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                  >
                    Read more →
                  </Link>
                </div>
              </div>
            </article>
          </Card>
        ))}
      </div>
    </section>
  );
}