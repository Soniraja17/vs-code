import express from "express";
import { AutoScalingClient, SetDesiredCapacityCommand, DescribeAutoScalingInstancesCommand, TerminateInstanceInAutoScalingGroupCommand } from "@aws-sdk/client-auto-scaling";
const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");

const app = express();
const client = new AutoScalingClient({ region: "ap-south-1", credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY!,
    secretAccessKey: process.env.AWS_ACCESS_SECRET!,
} });

const ec2Client = new EC2Client({ region: "ap-south-1", credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY!,
    secretAccessKey: process.env.AWS_ACCESS_SECRET!,
}})

type Machine = {
    ip: string;
    isUsed: boolean;
    assignedProject?: string;
    instanceId: string;
    lastActive: number; // timestamp in milliseconds
}

const ALL_MACHINES: Machine[] = []
const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes in milliseconds

async function refreshInstances() {
    try {
        const command = new DescribeAutoScalingInstancesCommand();
        const data = await client.send(command);

        if (!data.AutoScalingInstances?.length) {
            console.log("No instances found");
            return;
        }

        const ec2InstanceCommand = new DescribeInstancesCommand({
            InstanceIds: data.AutoScalingInstances.map(x => x.InstanceId)
        });

        const ec2Response = await ec2Client.send(ec2InstanceCommand);
        
        // Update ALL_MACHINES with current instances
        const currentInstances = new Set();
        
        for (const reservation of ec2Response.Reservations || []) {
            for (const instance of reservation.Instances || []) {
                if (instance.PublicIpAddress && instance.InstanceId) {
                    currentInstances.add(instance.InstanceId);
                    
                    const existingMachine = ALL_MACHINES.find(m => m.instanceId === instance.InstanceId);
                    if (!existingMachine) {
                        ALL_MACHINES.push({
                            ip: instance.PublicIpAddress,
                            isUsed: false,
                            instanceId: instance.InstanceId,
                            lastActive: Date.now()
                        });
                    }
                }
            }
        }

        // Remove machines that no longer exist
        const machinesToRemove = ALL_MACHINES.filter(m => !currentInstances.has(m.instanceId));
        for (const machine of machinesToRemove) {
            const index = ALL_MACHINES.findIndex(m => m.instanceId === machine.instanceId);
            if (index !== -1) {
                ALL_MACHINES.splice(index, 1);
            }
        }
    } catch (error) {
        console.error("Error refreshing instances:", error);
    }
}

async function cleanupInactiveMachines() {
    const now = Date.now();
    for (const machine of ALL_MACHINES) {
        if (machine.isUsed && (now - machine.lastActive) > INACTIVITY_TIMEOUT) {
            try {
                const command = new TerminateInstanceInAutoScalingGroupCommand({
                    InstanceId: machine.instanceId,
                    ShouldDecrementDesiredCapacity: true
                });
                await client.send(command);
                console.log(`Terminated inactive machine: ${machine.instanceId}`);
            } catch (error) {
                console.error(`Error terminating machine ${machine.instanceId}:`, error);
            }
        }
    }
}

// Initial refresh
refreshInstances();

// Refresh instances every 10 seconds
setInterval(refreshInstances, 10 * 1000);

// Check for inactive machines every minute
setInterval(cleanupInactiveMachines, 60 * 1000);

app.get("/:projectId", async (req, res) => {
    try {
        const idleMachine = ALL_MACHINES.find(x => !x.isUsed);
        if (!idleMachine) {
            // Scale up the infrastructure
            const command = new SetDesiredCapacityCommand({
                AutoScalingGroupName: "vscode-asg",
                DesiredCapacity: ALL_MACHINES.length + 1
            });
            await client.send(command);
            res.status(404).send("No idle machine found. Scaling up...");
            return;
        }

        idleMachine.isUsed = true;
        idleMachine.assignedProject = req.params.projectId;
        idleMachine.lastActive = Date.now();

        // Scale up if we're running low on idle machines
        if (ALL_MACHINES.filter(x => !x.isUsed).length < 2) {
            const command = new SetDesiredCapacityCommand({
                AutoScalingGroupName: "vscode-asg",
                DesiredCapacity: ALL_MACHINES.length + 1
            });
            await client.send(command);
        }

        res.send({
            ip: idleMachine.ip,
            instanceId: idleMachine.instanceId
        });
    } catch (error) {
        console.error("Error handling request:", error);
        res.status(500).send("Internal server error");
    }
});

app.post("/heartbeat/:instanceId", (req, res) => {
    const machine = ALL_MACHINES.find(m => m.instanceId === req.params.instanceId);
    if (machine) {
        machine.lastActive = Date.now();
        res.status(200).send("Heartbeat received");
    } else {
        res.status(404).send("Machine not found");
    }
});

app.post("/destroy", async (req, res) => {
    try {
        const { machineId } = req.body;
        if (!machineId) {
            res.status(400).send("machineId is required");
            return;
        }

        const command = new TerminateInstanceInAutoScalingGroupCommand({
            InstanceId: machineId,
            ShouldDecrementDesiredCapacity: true
        });

        await client.send(command);
        res.status(200).send("Machine termination initiated");
    } catch (error) {
        console.error("Error destroying machine:", error);
        res.status(500).send("Error destroying machine");
    }
});

app.listen(9092, () => {
    console.log("Worker orchestrator running on port 9092");
});

