import express from "express"
import { AutoScalingClient, DescribePoliciesCommand,SetDesiredCapacityCommand,DescribeAutoScalingInstancesCommand} from "@aws-sdk/client-auto-scaling";
import { InstanceAttributeName } from "@aws-sdk/client-ec2";
const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");


const app = express()


const client = new AutoScalingClient({ region: "REGION", credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
}
});
const ec2Client = new EC2Client({ region: "REGION", credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
}
});

const params = {
  /** input parameters */
};
const command = new SetDesiredCapacityCommand({
    AutoScalingGroupName: "my-auto-scaling-group",
  DesiredCapacity: 2,
})
const response = await client.send(command);
console.log(response);

type machine={
    ip:string;
    isUsed:boolean;
    assignedproject?:string;

}

const ALL_MACHINES:machine=[];

async function refereshinstances() {
    const command = new DescribeAutoScalingInstancesCommand();
    const data =await client.send(command);
    

    const ec2instance= new DescribeInstancesCommand({
        InstanceIds: data.AutoScalingInstances?.map(x => x.InstanceId)
    })
    const ec2Response = await ec2Client.send(ec2instance);
    
}


 
setInterval(()=>{
    refereshinstances;
},10*1000);


app.get("/projectId",(req,res)=>{
    const idleMachine = ALL_MACHINES.find(x => x.isUsed === false);
    if (!idleMachine) {
        // scale up the infrasturcture
        res.status(404).send("No idle machine found");
        return;
    }

    idleMachine.isUsed = true;
    // scale up the infrasturcture

    const command = new SetDesiredCapacityCommand({
        AutoScalingGroupName: "vscode-asg",
        DesiredCapacity: ALL_MACHINES.length + (5 - ALL_MACHINES.filter(x => x.isUsed === false).length)

    })

    client.send(command);

    res.send({
        ip: idleMachine.ip
    });


})
app.listen(9092);


  







