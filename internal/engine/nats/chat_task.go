package nats

import (
	"context"
	"errors"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// Chat work has a separate stream so ingestion redelivery keeps its own policy.
func (n *NatsEngine) InitChatTasks(ctx context.Context, namespace, consumer string, ackWait time.Duration, maxDeliver int) error {
	if n.jetStream == nil {
		return errors.New("chat queue: JetStream unavailable")
	}
	stream, err := n.jetStream.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name: namespace, Subjects: []string{namespace + ".>"},
		Retention: jetstream.WorkQueuePolicy, Storage: jetstream.FileStorage,
		Discard: jetstream.DiscardNew, MaxMsgs: 100000, MaxBytes: 64 << 20,
	})
	if err != nil {
		return err
	}
	_, err = stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable: consumer, AckPolicy: jetstream.AckExplicitPolicy,
		AckWait: ackWait, MaxDeliver: maxDeliver, MaxAckPending: 128,
		FilterSubject: namespace + ".ready",
	})
	return err
}

func (n *NatsEngine) PublishChatTask(ctx context.Context, namespace, id string) error {
	_, err := n.jetStream.Publish(ctx, namespace+".ready", []byte(id))
	return err
}

func (n *NatsEngine) PullChatTask(ctx context.Context, namespace, consumer string) (jetstream.Msg, error) {
	c, err := n.jetStream.Consumer(ctx, namespace, consumer)
	if err != nil {
		return nil, err
	}
	batch, err := c.Fetch(1, jetstream.FetchContext(ctx))
	if err != nil {
		return nil, err
	}
	for message := range batch.Messages() {
		return message, nil
	}
	return nil, batch.Error()
}
