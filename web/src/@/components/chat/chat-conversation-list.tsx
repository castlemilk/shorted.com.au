"use client";

import { useState } from "react";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/@/components/ui/alert-dialog";
import { Plus, Trash2, MessageSquare, Loader2 } from "lucide-react";
import { type ConversationSummary } from "~/@/hooks/use-chat";

interface ChatConversationListProps {
  conversations: ConversationSummary[];
  isLoading: boolean;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function ChatConversationList({
  conversations,
  isLoading,
  activeConversationId,
  onSelect,
  onDelete,
  onNewChat,
}: ChatConversationListProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleDelete = () => {
    if (deleteId) {
      onDelete(deleteId);
      setDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="p-3 border-b">
        <Button
          onClick={onNewChat}
          className="w-full"
          size="sm"
        >
          <Plus className="h-4 w-4 mr-2" />
          New chat
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 text-center px-4">
          <MessageSquare className="h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            No conversations yet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Start a new chat to begin
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors group hover:bg-muted ${
                  conv.id === activeConversationId
                    ? "bg-muted border border-border"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {conv.title}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(conv.updatedAt)}
                      </span>
                      {conv.contextStockCode && (
                        <Badge variant="outline" className="text-[10px] h-4 px-1">
                          {conv.contextStockCode}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteId(conv.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this conversation and all its
              messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
