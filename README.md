added# node-red-contrib-redlink

## What is Redlink

Redlink is a way of connecting many instances of Node-Red together using soft "service" connections to essentially create a cluster of "service" capability using disparate hardware to create a large grid Node-Red compute network.

## How does Redlink work

Redlink does not use a traditional messaging system, it actually creates a hierarchical mesh of interconnected web services 
using HTTPS-POST as its transport.

## Major benefits that this approach provides:

It allows a "Consumer" pull method of communication instead of a pub/sub push method for its transport system.

It allows each consumer to consume messages purely on its ability to process them and not have the producers force high workloads on consumers.

It allows scale out using container instances to instantiate many consumers dynamically as the load increases.

Producers do not have to know or care how message routing is provided, they simply have to have a link to another parent / peer that can route for them.

Producers are provided with a number of timers on each message to allow them:

	1/ To handle Consumers not processing the work
	2/ Alternate services to work around busy consumers
	3/ Expected end-to-end transaction times, allowing the producers to have an expectation of completeion.
	4/ Priority message processing.
	5/ Messages are stored in AlaSQL either ram or on disk.


## Why the decision to use AlaSQL as its internal DB

AlaSQL provides a very robust and high level of complexity using very simple SELECT statements and it reduces the code 
required to perform queueing and timing.

## Why Redlink uses peer to peer for "Notifications" 

The reason for this, is that multiple peer and consumer combinations have actually nothing to do with the production of messaging. What this means is that since Redlink is not a Publish-Subscribe system, more over publish to a single consumer
at a time model, this allows fan out micro services to consume messages based on their ability to consume. 
So, lets assume that I have 2 consumers on a service and both are busy, one will fetch the message and the other will get rejected as the first consumer has already consumed it from the producer.

## Redlink's design stengths are:
When a "Service" is advertised on this node it will not send notifies to its children.
When consumers register on nodes, the node automatically registers / deregisters its Services to their peer / parent. 

## Why not simply use a message broker system 

More complexity, this type of system removes one of layer and has a modern approach to web service architecture.

## Why is Redlink "Consumer" based messaging

As stated, the real issue of scale-out containerisation is that adding compute by using consumer based load distribution 
works well with Kubenetes / Docker / LXC.
Consumer based messaging is infinitly more secure as it is up to the consumer to actually transact the produces request 
based on merit.

## How Redlink actually communicates with other Redlink Instances

Each time a connection is established between nodes, the data is passed through and the connection is closed, this provides
a perfect way of using the least number of sockets with the maximum number of session / connections.

## Tree Hierachy

One of the greatest strengths of Redlink, is that a full redundant mesh can be designed and tested on either a single Node-Red instance or cluster of instances.

![RedlinkMesh](RedlinkMesh.png)

## Producer, Consumer, Reply to Sender/Receiver Socket design

![RedlinkSeq](redlink-seq1.png)



